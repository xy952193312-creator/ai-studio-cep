/**
 * diag.js — 诊断日志（环形缓冲 + 按天落盘）
 *
 * 为什么要有这个：
 *   排查 CEP 灰屏时最难受的是「没有任何反馈」—— 页面明明活着，偏偏画不出来，
 *   JS 日志看不到，面板里更是一片灰。为了这事曾经专门造过一个绿色测试面板
 *   （com.xy.probe）来判断「到底是环境问题还是我们自己的代码问题」；
 *   思路是对的，但独立扩展太笨重：占一个目录、占一个菜单项，而且只能回答一个是非题。
 *
 *   现在把它收进插件本身：「我的」页能直接看环境信息和日志，同时**往磁盘写一份**。
 *   落盘那一份才是关键——灰屏时面板根本打不开，只有磁盘上的文件能事后取证。
 *
 * 设计要点：
 *   1. 内存环形缓冲 300 条，超出丢最旧；
 *   2. 按天落盘到 <日志目录>/panel-YYYYMMDD.log，单文件 512KB 封顶；
 *   3. 刷盘是「追加新增」，不是全量覆盖——否则面板重启（收起面板会重建页面）
 *      后内存一空，当天已经记下的日志就被抹掉了；
 *   4. 全程 try-catch，日志自己绝不能把面板搞挂；
 *   5. 不记 apiKey，只记 URL 与状态，导出时不会泄密。
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};

  var MAX_ENTRIES = 300;          // 内存环形缓冲上限
  var FLUSH_EVERY = 20;           // 累积多少条刷一次盘
  var FLUSH_MS = 10000;           // 或距离上次刷盘多久刷一次
  var MAX_BYTES = 512 * 1024;     // 单文件封顶
  var IDLE_FLUSH_MS = 3000;       // 空闲时（无新日志）也定期补刷一次

  var buf = [];                   // 环形缓冲
  var seq = 0;                    // 全局递增序号
  var lastFlushed = 0;            // 已刷到哪个序号
  var flushing = false;           // 防止并发刷盘
  var lastFlushAt = 0;
  var timer = 0;

  var logDir = '';                // 日志目录（解析成功后填充）
  var dirState = 'unknown';       // unknown | ok | err
  var dirErr = '';

  /** 哪一天的 header 已经写过。跨天自动失效，无需额外处理 */
  var headerDay = '';
  /** 实际走的写入通道，env() 里展示——部署后一眼能看出 Node 追加有没有生效 */
  var writeMode = '';
  /** 刷盘成功后的回调。页面用它自动补画环境区，省得手动点刷新 */
  var flushHooks = [];

  var bootAt = Date.now();
  var sessionId = 'S' + bootAt.toString(36).toUpperCase();
  var fps = '—';                  // 由 app.js 的出帧观测回填
  var hostInfo = { psVersion: '', autoVisible: '', manifestErr: '' };

  /* ---------------- 小工具 ---------------- */

  function p2(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }

  /** 本地时间 hh:mm:ss.mmm —— 排查时对着截图看时间比看 UTC 方便 */
  function stamp(d) {
    d = d || new Date();
    return p2(d.getHours(), 2) + ':' + p2(d.getMinutes(), 2) + ':' +
           p2(d.getSeconds(), 2) + '.' + p2(d.getMilliseconds(), 3);
  }

  function dayKey(d) {
    d = d || new Date();
    return p2(d.getFullYear(), 4) + p2(d.getMonth() + 1, 2) + p2(d.getDate(), 2);
  }

  /** UTF-8 字符串转 Base64：CEP 的 cep.fs.writeFile 只收 Base64 */
  function toB64(str) {
    try {
      var enc = new TextEncoder();
      var bytes = enc.encode(str);
      var bin = '';
      var CHUNK = 8192;                       // 分块拼，避免大字符串一次性拼接卡顿
      for (var i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    } catch (e) {
      try { return btoa(unescape(encodeURIComponent(str))); } catch (e2) { return ''; }
    }
  }

  /** Base64 转 UTF-8 字符串 */
  function fromB64(b64) {
    try {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) {
      return '';
    }
  }

  /* ---------------- 落盘：CEP fs 优先，Node fs 兜底 ---------------- */

  function fsApi() {
    try { return (global.cep && global.cep.fs) ? global.cep.fs : null; } catch (e) { return null; }
  }

  function nodeFs() {
    try {
      if (typeof require !== 'function') return null;
      return require('fs');
    } catch (e) { return null; }
  }

  function readText(path) {
    var fs = fsApi();
    if (fs) {
      try {
        var r = fs.readFile(path, 'Base64');
        if (r && r.err === 0 && r.data != null) return fromB64(r.data);
      } catch (e) { /* 落到 Node 兜底 */ }
    }
    var nfs = nodeFs();
    if (nfs) {
      try { return nfs.readFileSync(path, 'utf8'); } catch (e2) { /* 读不到当空 */ }
    }
    return '';
  }

  function writeText(path, text) {
    var fs = fsApi();
    if (fs) {
      try {
        var w = fs.writeFile(path, toB64(text), 'Base64');
        if (w && w.err === 0) return true;
      } catch (e) { /* 落到 Node 兜底 */ }
    }
    var nfs = nodeFs();
    if (nfs) {
      try { nfs.writeFileSync(path, text, 'utf8'); return true; } catch (e2) { /* 都不行就放弃 */ }
    }
    return false;
  }

  /* ---------------- 日志目录 ---------------- */

  /**
   * 解析日志目录。
   * 依赖 ExtendScript（__aiLogDir），而 JSX 是 app.js 启动时才推的，
   * 所以这里延迟解析、失败就降级成「只记内存」，绝不抛异常。
   */
  var dirTries = 0;
  var DIR_MAX_TRIES = 5;      // 试几次就认命，退化成「只记内存」

  function resolveDir() {
    if (dirState === 'ok') return Promise.resolve(logDir);
    if (dirState === 'err' || dirTries >= DIR_MAX_TRIES) {
      return Promise.reject(new Error(dirErr || '日志目录不可用'));
    }
    if (!HH.ps || !HH.ps.evalScript || !HH.ps.available) {
      return Promise.reject(new Error('宿主接口未就绪'));   // 不计数：PS 可能还没起来
    }
    dirTries++;
    return HH.ps.evalScript('__aiLogDir()').then(function (raw) {
      var s = String(raw || '');
      if (s.indexOf('OK:') === 0) {
        logDir = s.slice(3).replace(/\/+$/, '');
        dirState = 'ok';
        return logDir;
      }
      dirState = 'err';
      dirErr = s.replace(/^ERR:\s*/, '') || '未知原因';
      throw new Error(dirErr);
    }).catch(function (e) {
      // JSX 还没推过去时会一直失败，别把它当成永久故障，但也别无限重试
      if (dirTries >= DIR_MAX_TRIES && dirState !== 'ok') {
        dirState = 'err';
        dirErr = dirErr || (e && e.message) || '未知原因';
      }
      throw e;
    });
  }

  /* ---------------- 记录 ---------------- */

  function push(level, tag, msg) {
    try {
      buf.push({ seq: ++seq, t: stamp(), level: level, tag: tag, msg: String(msg == null ? '' : msg) });
      if (buf.length > MAX_ENTRIES) buf.shift();

      // error 立即刷：灰屏这类故障往往伴随异常，这份记录最值钱，不能等节流
      if (level === 'error') { scheduleFlush(0); return; }

      if (seq - lastFlushed >= FLUSH_EVERY) scheduleFlush(0);
      else scheduleFlush(FLUSH_MS);
    } catch (e) { /* 记日志失败就静默，不能影响主流程 */ }
  }

  function scheduleFlush(delay) {
    if (timer) clearTimeout(timer);
    var wait = Math.max(0, delay || 0);
    if (!wait && Date.now() - lastFlushAt < 800) wait = 800;   // 防抖，别刷太密
    timer = setTimeout(function () { timer = 0; flush(); }, wait);
  }

  function line(e) {
    return '[' + e.t + '] ' + e.level.toUpperCase() + ' ' + e.tag + ' | ' + e.msg;
  }

  function header() {
    return '=== AI Studio 诊断日志 ' + dayKey() + ' · 会话 ' + sessionId +
           ' · 启动 ' + stamp(new Date(bootAt)) + ' ===';
  }

  /**
   * 刷盘。只追加「上次刷过之后新增的条目」，不是全量覆盖。
   * 文件超过 512KB 时改写为「头部 + 当前内存缓冲」，主动丢弃更早的历史。
   */
  function flush() {
    if (flushing) return Promise.resolve(false);
    var pending = [];
    for (var i = 0; i < buf.length; i++) if (buf[i].seq > lastFlushed) pending.push(buf[i]);
    if (!pending.length) return Promise.resolve(false);
    if (!logDir) {
      return resolveDir().then(function () { return doFlush(pending); })
                         .catch(function () { return false; });
    }
    return doFlush(pending);
  }

  function markFlushed(s) {
    lastFlushed = s;
    lastFlushAt = Date.now();
  }

  /**
   * 刷盘。两条路：Node 真追加（主）→ CEP 读回拼接（降级）。
   *
   * 为什么不再只用 CEP 那条路：
   *   它必须先「把旧内容读回来」再整体写回。而读回的结果分不清两种情况——
   *   「文件不存在」和「读取失败」都返回空串，代码只能一律当成前者，
   *   于是写出 header + 本次新增，把之前刷进去的内容整段抹掉。
   *   CEP 12 上 stat 取不到 size 就踩过一次（v1.2.1 修），
   *   读文件紧跟写文件时拿不到内容也会踩，只是概率低。
   *   取证用的日志最怕这个：故障当时写下的记录，被后面一次寻常刷盘抹掉。
   *
   *   Node 的 fs.appendFileSync 是内核级追加，压根不需要读旧内容——
   *   覆盖这个动作在物理上就不存在了。manifest 开着 --enable-nodejs，
   *   这条路可用；万一不可用，再退回 CEP，且带 headerDay 保险。
   */
  function doFlush(pending) {
    flushing = true;
    var ok = false;
    try {
      var path = logDir + '/panel-' + dayKey() + '.log';
      var add = pending.map(line).join('\n') + '\n';
      ok = appendViaNode(path, add, pending) || appendViaCep(path, add, pending);
    } catch (e) {
      ok = false;
    }
    flushing = false;
    if (ok) fireFlush();
    return ok;
  }

  /** 通知订阅者。逐个 try-catch：页面重绘出错绝不能反过来影响刷盘流程 */
  function fireFlush() {
    for (var i = 0; i < flushHooks.length; i++) {
      try { flushHooks[i](); } catch (e) { /* 忽略 */ }
    }
  }

  /** 主路径：Node 追加。不读旧内容，因此不可能覆盖 */
  function appendViaNode(path, add, pending) {
    var nfs = nodeFs();
    if (!nfs || typeof nfs.appendFileSync !== 'function') return false;

    try {
      var exists = false, size = 0;
      try {
        var st = nfs.statSync(path);
        exists = true;
        size = (st && st.size) || 0;
      } catch (e) { /* 抛异常就是文件还不存在 */ }

      if (!exists) {
        // 首次：建文件并写 header
        nfs.writeFileSync(path, header() + '\n', 'utf8');
        headerDay = dayKey();
      } else if (size > MAX_BYTES) {
        // 超限：重写成「header + 当前内存缓冲」，主动丢弃更早的记录
        nfs.writeFileSync(path, header() + '\n' + buf.map(line).join('\n') + '\n', 'utf8');
        headerDay = dayKey();
        writeMode = 'node-append';
        markFlushed(buf.length ? buf[buf.length - 1].seq : 0);
        return true;
      }

      nfs.appendFileSync(path, add, 'utf8');
      headerDay = dayKey();
      writeMode = 'node-append';
      markFlushed(pending[pending.length - 1].seq);
      return true;
    } catch (e) {
      return false;   // 静默降级，日志模块不能把面板搞挂
    }
  }

  /** 降级路径：CEP 读回拼接。保留，但加了一道「读不到不许覆盖」的保险 */
  function appendViaCep(path, add, pending) {
    var old = readText(path);

    /* 核心保险：本次会话确实往这个文件写过，现在却读不到内容——
       那只能是读取失败，绝不能当成「文件不存在」去覆盖。
       跳过这次刷盘、等下一轮重试，最多是晚一点落盘，不会毁掉已有记录。 */
    if (!old && headerDay === dayKey()) return false;

    if (old.length + add.length > MAX_BYTES) {
      writeText(path, header() + '\n' + buf.map(line).join('\n') + '\n');
      headerDay = dayKey();
      writeMode = 'cep-fs';
      markFlushed(buf.length ? buf[buf.length - 1].seq : 0);
      return true;
    }

    var text = old ? old + add : header() + '\n' + add;
    if (!writeText(path, text)) return false;

    headerDay = dayKey();
    writeMode = 'cep-fs';
    markFlushed(pending[pending.length - 1].seq);
    return true;
  }

  /* ---------------- 环境快照 ---------------- */

  function chromiumOf(ua) {
    var m = /Chrome\/(\d+)/.exec(ua) || /CEF\/(\d+)/.exec(ua);
    return m ? m[1] : '未知';
  }

  function lsBytes() {
    try {
      var n = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        n += (k ? k.length : 0) + (localStorage.getItem(k) || '').length;
      }
      return n;
    } catch (e) { return -1; }
  }

  function humanSize(n) {
    if (n < 0) return '未知';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 同步部分：不依赖宿主，随时可查 */
  function env() {
    var nav = global.navigator || {};
    var out = [
      ['插件版本', (HH.VERSION || '?')],
      ['会话', sessionId + ' · 启动 ' + stamp(new Date(bootAt))],
      ['Chromium', chromiumOf(nav.userAgent || '') + '  （CEP 9=61 / 10=74 / 11=88 / 12=99）'],
      ['User-Agent', nav.userAgent || '—'],
      ['Photoshop', hostInfo.psVersion || ((HH.ps && HH.ps.available) ? '已连接（版本查询中）' : '未连接')],
      ['面板尺寸', global.innerWidth + ' × ' + global.innerHeight + ' · DPR ' + (global.devicePixelRatio || 1)],
      ['出帧', fps],
      ['可见性', 'visibilityState=' + document.visibilityState +
                 ' · hidden=' + document.hidden +
                 ' · hasFocus=' + document.hasFocus() +
                 '  （CEP 里后两者恒为 false，属正常）'],
      ['AutoVisible', hostInfo.autoVisible || (hostInfo.manifestErr ? '读取失败：' + hostInfo.manifestErr : '读取中…')],
      ['日志目录', logDir || (dirState === 'err' ? '不可用（' + dirErr + '）' : '解析中…')],
      /* 部署后看一眼就知道主路径有没有真正生效：
         node-append = 追加写（不会覆盖）；cep-fs = 降级到读回拼接 */
      ['写入方式', writeMode || '尚未写入'],
      ['缓存目录', (HH.ps && HH._cacheDir) || '—'],
      ['Local Storage', humanSize(lsBytes())]
    ];
    return out;
  }

  /**
   * 异步补全：PS 版本 + manifest 的 AutoVisible。
   * AutoVisible 是灰屏的头号嫌疑，能直接读出来最省事——
   * 下次再出问题，看一眼这个值就不用重新排查一遍。
   */
  function probe() {
    if (HH.ps && HH.ps.evalScript && HH.ps.available) {
      HH.ps.evalScript('app.version').then(function (v) {
        var s = String(v || '');
        if (s && !/^ERR/.test(s)) hostInfo.psVersion = '已连接 · ' + s;
      }).catch(function () { /* 查不到就算了 */ });
    }

    resolveDir().catch(function () { /* 目录不可用不影响其他字段 */ });

    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'CSXS/manifest.xml', true);
      xhr.onload = function () {
        try {
          var m = /<AutoVisible>\s*(\w+)\s*<\/AutoVisible>/.exec(xhr.responseText || '');
          hostInfo.autoVisible = m ? m[1] : '未找到该节点';
        } catch (e) { hostInfo.manifestErr = e.message || '解析失败'; }
      };
      xhr.onerror = function () { hostInfo.manifestErr = '无法读取（file:// 受限）'; };
      xhr.send();
    } catch (e) {
      hostInfo.manifestErr = e.message || String(e);
    }
  }

  /* ---------------- 对外 ---------------- */

  function exportText() {
    var lines = [header(), ''];
    lines.push('---- 环境 ----');
    env().forEach(function (kv) { lines.push(kv[0] + ': ' + kv[1]); });
    lines.push('');
    lines.push('---- 日志（最近 ' + buf.length + ' 条）----');
    buf.forEach(function (e) { lines.push(line(e)); });
    return lines.join('\n');
  }

  function clear() {
    buf.length = 0;
    lastFlushed = 0;
    headerDay = '';      // 文件被删了，下次刷盘要重新写 header
    try {
      if (logDir) {
        var p = logDir + '/panel-' + dayKey() + '.log';
        var fs = fsApi();
        if (fs) { try { fs.deleteFile(p); } catch (e) { /* 删不掉就算了 */ } }
        var nfs = nodeFs();
        if (nfs) { try { nfs.unlinkSync(p); } catch (e2) { /* 同上 */ } }
      }
    } catch (e) { /* 忽略 */ }
  }

  /* 页面即将消失时补一次刷盘。CEP 面板收起是销毁重建，来不及也认了 */
  global.addEventListener('beforeunload', function () { try { flush(); } catch (e) {} });
  global.addEventListener('pagehide', function () { try { flush(); } catch (e) {} });

  /* 空闲期也定期补刷，避免只记了几条一直不落盘 */
  setInterval(function () {
    if (seq > lastFlushed) scheduleFlush(0);
  }, IDLE_FLUSH_MS);

  HH.diag = {
    /** log('info'|'warn'|'error', tag, msg) */
    log: function (level, tag, msg) { push(level || 'info', tag || 'app', msg); },
    info: function (tag, msg) { push('info', tag, msg); },
    warn: function (tag, msg) { push('warn', tag, msg); },
    error: function (tag, msg) { push('error', tag, msg); },

    /** 补一个环境字段（如出帧率），会被 env() 展示 */
    note: function (key, value) { if (key === 'fps') fps = value; },

    /**
     * 订阅「刷盘成功」。返回注销函数。
     * 页面用它自动补画环境区——「写入方式」这类字段要落过盘才有值，
     * 只在挂载时画一次的话会一直停在「尚未写入」。
     */
    onFlush: function (cb) {
      if (typeof cb !== 'function') return function () {};
      flushHooks.push(cb);
      return function () {
        var i = flushHooks.indexOf(cb);
        if (i >= 0) flushHooks.splice(i, 1);
      };
    },

    env: env,
    probe: probe,
    entries: function () { return buf.slice(); },
    exportText: exportText,
    clear: clear,
    flush: flush,
    dir: function () { return logDir; },
    dayFile: function () { return logDir ? logDir + '/panel-' + dayKey() + '.log' : ''; },
    sessionId: sessionId
  };

  HH.diag.info('boot', '页面启动 · 会话 ' + sessionId);

})(window);
