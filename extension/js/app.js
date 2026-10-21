/**
 * app.js — 应用入口：Tab 导航 + Hash 路由 + 页面挂载
 *
 * 路由表（四个 Tab）：
 *   #/edit      智能改图
 *   #/generate  AI 生图
 *   #/history   历史记录
 *   #/mine      我的
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util, S = HH.store, UI = HH.ui;

  var TABS = [
    { key: 'edit', name: '智能改图' },
    { key: 'generate', name: 'AI生图' },
    { key: 'history', name: '历史记录' },
    { key: 'mine', name: '我的' }
  ];

  var view = null;

  /** 上一次成功挂载的路由 —— 用来压制「同一个页面被连挂两次」 */
  var mounted = '';
  /** 启动阶段：init 自己挂过一次，紧随其后的那次 hashchange 要吞掉 */
  var booting = false;
  /** 上一次挂载前的滚动位置，来回切页时找回原位 */
  var scrollMemo = {};
  var lastRoute = '';

  /* ---------------- 路由 ---------------- */
  function currentRoute() {
    var m = /^#\/([a-zA-Z]+)/.exec(location.hash || '');
    var key = m ? m[1] : 'edit';
    for (var i = 0; i < TABS.length; i++) if (TABS[i].key === key) return key;
    return 'edit';
  }

  function go(route) {
    if ('#/' + route === location.hash) {
      /* 点的是当前页：绝不重挂。
         以前这里调 mount()，于是「连点两下同一个 Tab」会在日志里留下两条
         同名 mount，而且整页被destroy重建——滚动位置回顶、输入框焦点丢失。
         确实需要刷新数据的走 remount()。 */
      return;
    }
    location.hash = '#/' + route;
  }

  /* ---------------- Tab 渲染 ---------------- */
  function renderTabs() {
    var box = U.$('#tabs');
    if (!box) return;
    var route = currentRoute();
    box.innerHTML = TABS.map(function (t) {
      return '<div class="sp-tab' + (t.key === route ? ' selected' : '') + '" data-tab="' + t.key + '">' +
        '<span class="sp-tab-title">' + t.name + '</span>' +
      '</div>';
    }).join('');
  }

  /* ---------------- 跨页意图（重新编辑 / 打开历史对话） ---------------- */
  function applyIntent(route) {
    var it = S.takeIntent();
    if (!it || it.page !== route) return;

    if (route === 'edit') {
      var e = S.state.edit;

      // 打开历史对话：会话本身已经在 history 页切好了，这里只负责提示 + 定位
      if (it.sessionId) {
        S.state.ui.focusResult = it.focusResult || '';
        var sess = S.findSession(it.sessionId);
        var st = S.sessionStats(sess);
        UI.toast('已打开历史对话 · ' + st.rounds + ' 轮 ' + st.images + ' 张图', 'ok');
        return;
      }

      e.prompt = it.prompt || '';
      e.model = it.model || e.model;
      if (it.images && it.images.length) e.images = it.images;
      UI.toast('已载入历史参数，可直接再次生成', 'ok');
    } else if (route === 'generate') {
      var g = S.state.generate;
      g.prompt = it.prompt || '';
      g.model = it.model || g.model;
      UI.toast('已载入历史提示词', 'ok');
    }
  }

  /* ---------------- 挂载 ---------------- */
  /**
   * 重建页面容器。
   *
   * 各页的 bind(root) 都把事件委托挂在 #view 上，而 #view 是常驻节点；
   * 若只换 innerHTML，监听器会随着每次挂载不断叠加，导致「点一次触发多次」。
   * 直接换掉节点，旧监听随旧节点一起回收，从根上杜绝重复绑定。
   */
  function freshView() {
    var old = U.$('#view');
    var el = document.createElement('main');
    el.id = 'view';
    el.className = old ? old.className : 'sp-tab-page';
    if (old && old.parentNode) old.parentNode.replaceChild(el, old);
    return el;
  }

  /**
   * 挂载页面。
   * @param {string} [why] 触发原因（boot / 守卫 / 外部刷新…）。只有「真的换了页」才记日志，
   *                       并且把原因带上，这样一眼能看出这条是启动挂载还是重试挂载。
   */
  function mount(why) {
    var route = currentRoute();
    var reason = why || (mounted ? '切页' : 'boot');

    S.state.route = route;
    applyIntent(route);

    renderTabs();

    var page = HH.pages[route];
    view = freshView();

    if (!page) {
      view.innerHTML = UI.empty('页面不存在');
      mounted = route;
      return;
    }

    scrollMemo[lastRoute] = view.scrollTop;

    view.scrollTop = scrollMemo[route] || 0;
    view.innerHTML = page.render();
    page.bind(view);
    mounted = route;
    lastRoute = route;
    syncBadge();

    try {
      if (HH.diag) HH.diag.info('mount', '挂载页面 ' + route + ' · ' + reason);
    } catch (e) {}
  }

  /**
   * 原地刷新：路由不变，只是页面数据变了（配置保存、历史删除、日志清空…）。
   *
   * 和 mount() 的区别是「什么都不重建」——不碰 hash、不重新算路由、不弹跨页提示，
   * 日志单独记成 `remount`。
   *
   * 为什么必须分开：以前这些刷新一律走整条 mount()，副作用是日志里到处是
   * 同名的「挂载页面」，真出问题时根本分不清哪条是页面切换、哪条是保存配置后的重绘。
   */
  function remount() {
    var route = currentRoute();
    var page = HH.pages[route];
    if (!page) return;

    view = freshView();
    view.innerHTML = page.render();
    page.bind(view);
    lastRoute = route;
    syncBadge();

    try {
      if (HH.diag) HH.diag.info('remount', '重绘页面 ' + route);
    } catch (e) {}
  }

  /** 保留旧名字：外部（pages/*、store.js）一直在调 HH.app.refresh()，语义就是原地刷新 */
  function refresh() {
    remount();
  }

  /* ---------------- 顶部状态徽标 ---------------- */
  function syncBadge() {
    var el = U.$('#apiBadge');
    if (!el) return;
    var ok = HH.api.isConfigured();
    el.textContent = ok ? '已配置' : '未配置';
    el.title = ok ? '已接入自定义 API，点击查看' : '未配置 API，点击前往「我的」';
    el.classList.toggle('is-ok', ok);
  }

  /* ---------------- 强制重绘（治 CEP 白屏） ----------------
     CEP/CEF 在面板被收起（»）、被隐藏或重新打开后，经常出现
     「DOM 完整、readyState=complete，但窗口一片空白」——合成层没重绘。
     这里在窗口重新获得焦点 / 页面重新可见时，强制重建一次渲染层。
     注意：不要在这里读文件、弹系统对话框，任何同步阻塞都会让渲染线程彻底卡死。 */
  var repaintLock = 0;

  var repaintCount = 0;

  function kickRepaint() {
    var now = Date.now();
    if (now - repaintLock < 800) return;   // 防止连续触发抖动
    repaintLock = now;

    // 正在输入时不打断（会丢光标/中断中文输入法组词）
    var ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;

    try { if (HH.diag) HH.diag.info('repaint', '强制重绘 #' + (++repaintCount)); } catch (e) {}

    try {
      // 记录滚动位置，重建渲染层后恢复，避免聊天流跳到顶部
      var keeps = [];
      var all = document.querySelectorAll('#view *');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.scrollTop > 0 || el.scrollLeft > 0) {
          keeps.push({ el: el, t: el.scrollTop, l: el.scrollLeft });
        }
      }

      var de = document.documentElement;
      de.style.display = 'none';
      void de.offsetHeight;                // 强制同步重排
      de.style.display = '';

      keeps.forEach(function (k) { k.el.scrollTop = k.t; k.el.scrollLeft = k.l; });
      window.dispatchEvent(new Event('resize'));
    } catch (e) { /* 重绘失败不影响功能 */ }
  }

  /* 分几个时间点补绘：CEF 有时要 1 秒后才真正恢复绘制 */
  function scheduleKick() {
    [80, 700, 1600].forEach(function (ms) { setTimeout(kickRepaint, ms); });
  }

  /* ---------------- 启动期自动救灰屏 ----------------

     背景（这是踩过坑才写的）：
       面板从「窗口 > 扩展功能」打开时，页面一出生就是可见的
       （document.hidden 恒为 false），visibilitychange 不来；
       CEP 面板里 document.hasFocus() 也恒为 false，focus 事件同样不来。
       于是 visibilitychange / focus / pageshow 这三个钩子全部踏空，
       重启 PS 后第一次开面板就是一片灰，用户只能自己去拖分隔条。

     做法：启动后按节奏反复补绘，直到「页面确实在出帧」为止。
       判据用 requestAnimationFrame 是否被真正回调 —— 灰屏/视图没挂上时，
       CEF 不产生合成帧，rAF 回调会被饿死（或极慢）；绘制正常时稳定 60fps 左右。
       这比看 DOM 状态靠谱：灰屏时 DOM 是完好的，唯独不出帧。 */
  var paintCheckTimer = 0;

  /** 观察一段时间内 rAF 的回调次数，判断渲染是否在出帧 */
  function framesIn(ms, cb) {
    var t0 = Date.now();
    var count = 0;
    var stop = false;
    var fallback = setTimeout(function () {
      // 连一帧都没来也不至于卡死
      if (!stop) { stop = true; cb(0); }
    }, ms + 600);

    function tick() {
      if (stop) return;
      count++;
      if (Date.now() - t0 >= ms) {
        stop = true;
        clearTimeout(fallback);
        cb(count);
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function watchPaint() {
    var tries = 0;
    var MAX = 15;        // 最多补 15 次，覆盖到启动后约 20 秒
    var ROUND = 400;     // 每轮观察 400ms
    var blanks = 0;      // 连续「一帧都没出」的轮数
    var reloaded = false;

    function done() {
      if (paintCheckTimer) clearTimeout(paintCheckTimer);
      paintCheckTimer = 0;
    }

    /* 补绘救不回来时的最后手段：整页重载。
       guard.js 里那只看门狗只认「Tab 没渲染出来」，而灰屏时 Tab 是好的，
       所以它由这里来触发。限次（同会话最多 2 次）在 guard 内部做。 */
    function escalate() {
      if (reloaded) return;
      reloaded = true;
      try {
        if (HH.guard && HH.guard.autoReload) {
          HH.guard.autoReload('启动后画面一直没有出帧');
        }
      } catch (e) { /* 重载失败就保持现状，用户手动拖一下分隔条也能救回来 */ }
    }

    function round() {
      if (tries++ >= MAX) { escalate(); return; }

      framesIn(ROUND, function (n) {
        // 400ms 里跑够 4 帧（≥10fps）就认为绘制正常，收工
        if (n >= 4) {
          try {
            if (HH.diag) {
              // ROUND 毫秒 n 帧 → 折算 fps
              var f = Math.round(n * 1000 / ROUND);
              HH.diag.note('fps', f + ' fps');
              HH.diag.info('paint', '绘制正常 · ' + f + ' fps · 第 ' + tries + ' 轮');
            }
          } catch (e) {}
          return done();
        }

        try {
          if (HH.diag) {
            HH.diag.warn('paint', '第 ' + tries + ' 轮只出了 ' + n + ' 帧' +
              (n === 0 ? '（一帧未出）' : ''));
          }
        } catch (e) {}

        if (n === 0) blanks++; else blanks = 0;

        // 连续 6 轮（≈6.5 秒）一帧都不出：补绘已经没意义，直接重载
        if (blanks >= 6) return escalate();

        kickRepaint();
        paintCheckTimer = setTimeout(round, 700);
      });
    }

    paintCheckTimer = setTimeout(round, 400);
  }

  /* 面板重新可见 / 重新获得焦点时补一次重绘 */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) scheduleKick();
  });
  window.addEventListener('focus', scheduleKick);
  window.addEventListener('pageshow', scheduleKick);

  /* 面板尺寸变化（拖动分隔条、拉大面板）同样会丢绘制，顺手补一次 */
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(kickRepaint, 120);
  });

  /* ---------------- 启动 ---------------- */
  function init() {
    view = U.$('#view');
    UI.bindGlobal();

    /* 把 jsx/host.jsx 重新推给 ExtendScript：CEP 只在扩展首次加载时跑 ScriptPath，
       改了 JSX 不重推就会一直执行旧函数 */
    if (HH.ps && HH.ps.loadJSX) {
      HH.ps.loadJSX().then(function (ok) {
        if (!ok) console.warn('[app] JSX 未能同步，插入图层 / 读取选区可能仍是旧版本');
      });
    }

    /* Tab 点击 */
    U.$('#tabs').addEventListener('click', function (e) {
      var tab = e.target.closest('[data-tab]');
      if (tab) go(tab.getAttribute('data-tab'));
    });

    /* 徽标跳「我的」 */
    U.$('#apiBadge').addEventListener('click', function () {
      go('mine');
    });

    /* 首次挂载交给 hash 路由，但只挂一次。
       坑在这里：赋 location.hash 会【异步】派发一次 hashchange。
       如果这里再同步 mount() 一次，那一次就是两个 mount：
       启动时 hash 为空 → 赋成 #/edit → 这里挂 edit → 下一拍 hashchange 又挂 edit。
       日志里那两条相隔 10ms 的「挂载页面 edit」就是这么来的。
       现在给 hashchange 加个 once 标记，启动阶段的事件不重复触发挂载。 */
    booting = true;
    if (!location.hash) location.hash = '#/edit';
    mount('boot');
    /* 50ms 后才解除：hashchange 的派发时机不保证是「下一个 tick」，
       CEP 里偶尔拖到十几毫秒。给足余量，同时也不至于把真正的用户切页吞掉。 */
    setTimeout(function () { booting = false; }, 50);

    /* 首帧兜底：面板刚被重新打开时，CEF 常丢掉第一次绘制 */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { setTimeout(kickRepaint, 150); });
    });

    /* 启动期救灰屏：反复补绘直到画面真的有内容（原因见 watchPaint 注释） */
    watchPaint();

    /* 补全诊断信息：PS 版本、manifest 的 AutoVisible、日志目录。
       这些都是异步的，晚几百毫秒没关系，别挡着首屏渲染。 */
    setTimeout(function () {
      try { if (HH.diag) HH.diag.probe(); } catch (e) {}
    }, 800);

    /* 续取上次没跑完的任务：面板被收起/关掉时，服务端还在跑，
       任务 ID 已经同步写进 localStorage，回来接着问就能把图拿回来 */
    if (HH.tasks && HH.tasks.resume) {
      setTimeout(function () {
        try { HH.tasks.resume(); } catch (e) { console.warn('[app] 任务续取失败', e); }
      }, 1500);
    }

    if (!HH.api.isConfigured()) {
      setTimeout(function () {
        UI.toast('未配置 API，当前使用占位图演示。可到「我的」填写自己的服务地址');
      }, 600);
    }
  }

  window.addEventListener('hashchange', function () {
    // init 刚挂过，紧接着的这一拍是它自己赋 hash 引出来的，跳过（只吞一次）
    if (booting) { booting = false; return; }
    mount('切页');
  });

  HH.app = {
    go: go,
    mount: mount,
    remount: remount,
    refresh: refresh,
    syncBadge: syncBadge,
    kickRepaint: kickRepaint,
    currentRoute: currentRoute
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window);
