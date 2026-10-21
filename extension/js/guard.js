/**
 * guard.js — 兜底与自愈（必须最先加载）
 *
 * 为什么需要：
 *   CEP 面板「白屏」最难的地方是**没有任何反馈** —— 既没有报错，也没有提示，
 *   面板里就剩一块底色，只能靠猜。更糟的是有些故障是「页面活着但没画出来」，
 *   此时任何 JS 日志都看不到。
 *
 * 这个文件做三件事：
 *   1. 捕获所有未处理的 JS 异常 / Promise 拒绝，直接在面板顶上写出来
 *      （写出来 = 用户能截图告诉我 = 不用再盲猜）；
 *   2. 启动看门狗：2.5 秒后检查 Tab 有没有渲染出来。没渲染出来就再 mount 一次，
 *      还不行就显示「界面没渲染出来 · 重新加载」的按钮；
 *   3. 面板从隐藏恢复可见时，如果界面还是空的，自动 reload 一次（同一会话最多两次）。
 *
 * 注意：这里只做「显示 + 重试」，不读文件、不发请求，绝不能阻塞渲染线程。
 */
(function (global) {
  'use strict';

  var HK = '_hh_guard_reload_at';
  var MAX_ERRS = 6;
  var shown = 0;
  var box = null;

  function ensureBox() {
    if (box && box.parentNode) return box;
    if (!document.body) return null;
    box = document.createElement('div');
    box.id = '__hhGuard';
    box.setAttribute('style', [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483000',
      'max-height:55%', 'overflow:auto', 'display:none',
      'background:#7a1414', 'color:#fff', 'padding:6px 8px',
      'font:11px/16px Consolas,Menlo,monospace', 'white-space:pre-wrap',
      'box-shadow:0 2px 8px rgba(0,0,0,.5)'
    ].join(';'));
    document.body.appendChild(box);
    return box;
  }

  /** 把错误写到面板顶上（同一条消息只写一次，避免刷屏） */
  function report(kind, text) {
    try {
      var b = ensureBox();
      if (!b) return;
      if (b.textContent.indexOf(text) >= 0) return;
      if (shown >= MAX_ERRS) return;
      shown++;

      var line = document.createElement('div');
      line.textContent = '[' + kind + '] ' + text;
      b.appendChild(line);
      // 附带一个重新加载入口，出问题时用户自己能救回来
      if (!b.querySelector('button')) {
        var btn = document.createElement('button');
        btn.textContent = '重新加载面板';
        btn.style.cssText = 'margin-top:6px;padding:2px 10px;font:12px system-ui;cursor:pointer;' +
          'background:#fff;color:#7a1414;border:0;border-radius:3px';
        btn.onclick = function () { location.reload(); };
        b.appendChild(btn);
      }
      b.style.display = 'block';
    } catch (e) { /* 连兜底都失败就什么都别做 */ }

    /* 红条只在面板里显示，灰屏时用户根本看不见。
       同时写一份日志（含落盘），事后能从磁盘上取证。 */
    try {
      if (!global.HH || !global.HH.diag) return;
      var lv = (kind === '异常' || kind === '异步') ? 'error'
             : (kind === '自愈' || kind === '挂载') ? 'warn' : 'info';
      global.HH.diag.log(lv, 'guard', kind + ' · ' + text);
    } catch (e2) { /* 记日志失败不影响红条 */ }
  }

  function fileOf(url) {
    var s = String(url || '');
    var m = /([^\/\\]+)$/.exec(s);
    return m ? m[1] : s;
  }

  global.addEventListener('error', function (e) {
    // 资源加载失败（link/script/img 404）也会走这里，e.message 为空
    if (!e) return;
    var msg = e.message || ('资源加载失败：' + fileOf(e.target && (e.target.src || e.target.href)));
    var at = e.filename ? ' @ ' + fileOf(e.filename) + ':' + e.lineno + ':' + e.colno : '';
    report('异常', msg + at);
  }, true);

  global.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report('异步', (r && (r.stack || r.message)) || String(r));
  });

  /* ---------------- 启动看门狗 ---------------- */
  var retried = false;

  function tabsRendered() {
    var t = document.getElementById('tabs');
    return !!(t && t.children.length);
  }

  function canAutoReload() {
    try {
      var last = Number(sessionStorage.getItem(HK) || 0);
      var n = Number(sessionStorage.getItem(HK + '_n') || 0);
      if (n >= 2) return false;
      if (Date.now() - last < 8000) return false;
      sessionStorage.setItem(HK, String(Date.now()));
      sessionStorage.setItem(HK + '_n', String(n + 1));
      return true;
    } catch (e) {
      return false;
    }
  }

  function watchdog() {
    if (tabsRendered()) return;

    // 第一轮：可能只是 mount 时机不对，手动再挂一次。
    // 只有「界面确实是空的」才走到这里，正常启动不会触发，所以这条 mount 属于罕见路径，
    // 挂载日志里带上 boot 之外的原因，一眼就能认出是守卫补挂的。
    if (!retried) {
      retried = true;
      try {
        if (global.HH && global.HH.app && global.HH.app.mount) global.HH.app.mount('guard');
      } catch (e) {
        report('挂载', (e && e.message) || String(e));
      }
      setTimeout(watchdog, 1200);
      return;
    }

    // 第二轮：还是空的 —— 说明页面脚本没跑起来。自动 reload 一次（CEF 重载后基本都能画出来）
    if (canAutoReload()) {
      report('自愈', '界面没有渲染出来，正在自动重新加载…（第 1 次）');
      setTimeout(function () { location.reload(); }, 600);
      return;
    }
    report('提示', '界面没有渲染出来。点上面的「重新加载面板」，或把面板拖出成浮动窗口再试。');
  }

  function start() {
    ensureBox();
    setTimeout(watchdog, 2500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /* 面板被收起再展开后，如果界面还是空的，补一次自愈 */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    setTimeout(function () {
      if (!tabsRendered() && canAutoReload()) {
        report('自愈', '面板恢复可见但界面是空的，正在重新加载…');
        location.reload();
      }
    }, 1500);
  });

  /* ---------------- 对外：请求一次自愈重载 ----------------
     给 app.js 的「灰屏看门狗」用。
     上面那只看门狗只判断「Tab 有没有渲染出来」，但 CEF 灰屏的典型症状恰恰是
     **DOM 好端端的、Tab 也在，就是不出帧**，于是它永远不触发。
     这里补一个入口：由调用方确认「确实没在绘制」，再来申请重载。
     限次逻辑复用 canAutoReload()，避免和看门狗叠加成无限刷新。 */
  function requestReload(reason) {
    if (!canAutoReload()) return false;
    report('自愈', reason + '（画面始终没绘制出来，自动重新加载第 ' +
      sessionStorage.getItem(HK + '_n') + ' 次）');
    setTimeout(function () { location.reload(); }, 400);
    return true;
  }

  global.HH = global.HH || {};
  global.HH.guard = { report: report, autoReload: requestReload };

})(window);
