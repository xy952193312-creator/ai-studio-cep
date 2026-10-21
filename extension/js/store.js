/**
 * store.js — 极简状态容器 + localStorage 持久化
 *
 * 持久化内容：
 *   api       自定义 API 配置
 *   history   图片记录（每条 = 一张生成结果，历史页「图片记录」列表用）
 *   sessions  对话会话（每条 = 一次完整对话，含全部消息；用于「对话记录」与双击回看）
 *
 * 三者关系：
 *   session.messages[].results[].id  ←→  history[].id
 *   会话里只存缩略图，原图活在 history 里；history 被清掉时，会话退回缩略图。
 *
 * 不持久化：输入框内容、尚未发送的临时参考图
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util;

  var K_API = 'aistudio.api.v1';
  var K_HIST = 'aistudio.history.v1';
  var K_SESS = 'aistudio.sessions.v1';
  var K_UI = 'aistudio.ui.v1';

  var KEEP_FULL = 8;        // 历史中保留原图的条数（其余只留缩略图）
  var MAX_HISTORY = 60;     // 历史最大条数
  var LS_SESS = 8;          // localStorage 兜底模式最多保留的会话数
  var KEEP_SESS = 300;      // 磁盘模式的上限（只受磁盘限制，这里仅防失控）
  var MAX_SESS_MSGS = 60;   // 单个会话最多存多少条消息
  var MAX_INLINE = 160000;  // 单张内联图字符上限（约 120KB），超了就只存 id 引用

  var DEFAULT_API = {
    baseUrl: '',                 // 例：https://api.openai.com
    apiKey: '',
    model: '',                   // 主模型名称
    path: '/v1/images/generations',
    protocol: 'openai',          // openai | custom
    timeout: 120,                // 秒
    modelList: '',               // 常用模型（逗号分隔），用于页面下拉
    modelCache: '',              // 从服务端拉取的模型列表（JSON 字符串）
    modelCacheAt: 0,             // 上次拉取时间戳
    extraHeaders: '',            // 追加请求头，形如：X-Foo: bar（每行一条）
    async: true                  // 异步出图：先拿 task_id 再轮询，折叠面板也不丢图
  };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  /* ================= 会话数据整形 ================= */
  function isSession(s) {
    return s && typeof s === 'object' && typeof s.id === 'string' && s.id;
  }

  /** 读盘后补齐会话的必填字段，避免老数据 / 半截数据把页面炸掉 */
  function fixSession(s) {
    var out = {
      id: String(s.id),
      page: s.page === 'generate' ? 'generate' : 'edit',
      title: String(s.title || ''),
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Number(s.updatedAt) || Number(s.createdAt) || Date.now(),
      model: String(s.model || ''),
      ratio: String(s.ratio || ''),
      messages: Array.isArray(s.messages) ? s.messages : []
    };

    out.messages = out.messages.filter(function (m) { return m && m.role; }).map(function (m) {
      var msg = {
        id: m.id || U.uid('m'),
        role: m.role === 'user' ? 'user' : 'assistant',
        prompt: String(m.prompt || ''),
        model: m.model || '',
        ratio: m.ratio || '',
        status: m.status === 'running' ? 'error' : (m.status || 'done'),
        error: m.error || (m.status === 'running' ? '生成被中断（面板曾关闭）' : ''),
        createdAt: Number(m.createdAt) || out.createdAt,
        images: Array.isArray(m.images) ? m.images : [],
        results: Array.isArray(m.results) ? m.results : [],
        // 异步出图的任务 ID：留着，面板重开后能凭它把图取回来
        taskId: String(m.taskId || ''),
        taskStatus: String(m.taskStatus || ''),
        progress: String(m.progress || '')
      };

      // 结果图回填缩略图字段，避免渲染时拿到 undefined。
      // 注意：**不要把 thumb 塞进 dataUrl** —— dataUrl 的语义是「原图」，
      // 塞了缩略图之后，预览/下载会把 360px 当成原图直接用（踩过）。
      msg.results.forEach(function (r) {
        var t = String(r.thumb || '');
        if (t.indexOf('data:') !== 0) {
          // 只认 base64：file:// 在 CEP 面板里加载不了（实测 naturalWidth=0），
          // 磁盘上的图由渲染层按 thumbFile 异步读回来
          var d = String(r.dataUrl || '');
          r.thumb = d.indexOf('data:') === 0 ? d : '';
        }
      });

      return msg;
    });

    if (!out.title) out.title = titleOf(out);
    return out;
  }

  function titleOf(sess) {
    var msgs = (sess && sess.messages) || [];
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user' && msgs[i].prompt) {
        return String(msgs[i].prompt).replace(/\s+/g, ' ').slice(0, 24);
      }
    }
    return '';
  }

  /**
   * 清洗历史图片记录里的「假原图」
   *
   * 旧版本为了不撑爆 localStorage（5MB），把超过 900KB 的原图
   * 直接换成了 360px 缩略图再写进 full 字段。于是这批老记录里
   * full === thumb —— 点插入/下载拿到的其实是 360 缩略图，
   * 放大铺满选区后很糊，但提示语（只显示选区尺寸）完全看不出来。
   *
   * 这里把这类记录识别出来：清掉假的 full，打上 lowRes 标记，
   * 让 ps.imageInfo 能如实报「原图已丢失，当前只有 360×360 缩略图」。
   */
  function fixHistory(e) {
    if (!e || typeof e !== 'object' || !e.id) return null;

    var thumb = String(e.thumb || '');
    var full = String(e.full || '');

    if (full && thumb && full === thumb) {
      e.full = '';
      e.lowRes = true;
    }
    // 连缩略图都没有、也没有磁盘文件 → 这条记录已经没图可看
    if (!thumb && !e.thumbFile && !e.file && !full) e.lowRes = true;

    return e;
  }

  /* ================= 状态 ================= */
  var savedSessions = read(K_SESS, []);
  if (!Array.isArray(savedSessions)) savedSessions = [];

  var savedUi = read(K_UI, {}) || {};

  /**
   * 「我的」页区块折叠的默认值
   *
   * 默认只展开「API 服务配置」：没配 API 之前，那是唯一必须填的东西。
   * 其余六块都是「用过才需要」的高级项，全展开会把这一页拉得比面板还长，
   * 想找「清理」要滚半天。
   */
  var MINE_SECTIONS = {
    api: true,        // API 服务配置
    storage: false,   // 对话存储位置
    insert: false,    // 插入图层方式
    deliver: false,   // 出图方式
    fetch: false,     // 任务取回
    clean: false,     // 清理
    diag: false       // 诊断与日志
  };

  /**
   * 折叠状态逐项校验，不整体信任 localStorage
   *
   * 以后新增或改名一个区块，老数据里没有那个 key，直接读会得到 undefined，
   * 折叠就变成「看运气」。这里拿默认值打底，只覆盖读到的合法布尔值。
   */
  function normalizeMineOpen(v) {
    var out = {};
    Object.keys(MINE_SECTIONS).forEach(function (k) {
      out[k] = (v && typeof v[k] === 'boolean') ? v[k] : MINE_SECTIONS[k];
    });
    return out;
  }

  var state = {
    route: 'edit',

    api: Object.assign({}, DEFAULT_API, read(K_API, {})),

    history: read(K_HIST, []).map(fixHistory).filter(Boolean),

    // 对话会话（最新的在最前）
    sessions: savedSessions.filter(isSession).map(fixSession),

    // 智能改图页（表单态，切换页面不丢）
    edit: {
      sessionId: '',       // 当前会话 id（与 sessions 中的一条对应）
      messages: [],        // === 当前会话的 messages 数组（同一引用，push 直接生效）
      images: [],          // 待发送的参考图（上传或 PS 选区）[{id, dataUrl, name}]
      prompt: '',
      negative: '',
      model: '',
      ratio: '1:1',
      count: 1,
      quality: 'auto',     // 生图质量档位；可用值由模型决定（见 api.qualityOptions）
      running: false,
      results: []          // 兼容旧字段，对话流下由 messages 承载
    },

    // AI 生图页
    generate: {
      prompt: '',
      negative: '',
      model: '',
      ratio: '1:1',
      count: 1,
      style: '',
      quality: 'auto',   // 生图质量档位；具体可用值由模型决定（见 api.qualityOptions）
      // 参考图。有图 = 图生图（走 /v1/images/edits），无图 = 文生图。
      // 这里不再单独存 mode —— 模式是「有没有图」推导出来的，
      // 存两份状态迟早会出现「切了模式但图还在」的不一致
      images: [],
      running: false,
      results: [],
      taskId: '',        // 异步出图的任务 ID
      taskStatus: '',    // queued / in_progress / completed
      taskProgress: ''   // 服务端回的百分比，如 "60%"
    },

    ui: {
      // 上次停留的视图 / 筛选，记在本机，下次打开还是那一页
      historyView: savedUi.historyView === 'sessions' ? 'sessions' : 'images',
      historyFilter: ['all', 'edit', 'generate'].indexOf(savedUi.historyFilter) >= 0
        ? savedUi.historyFilter : 'all',
      testing: false,
      testResult: null,
      editingId: null,
      focusResult: '',         // 打开历史对话后要高亮的那张图

      // 插入图层是否用「智能对象」（默认开，可在「我的」里关）
      // true：保留原始像素，缩放是变换，裁边用蒙版 → 全程可逆
      // false：重采样到目标尺寸 + clear() 硬裁 → 拿到手就能直接画笔涂抹
      insertSmart: savedUi.insertSmart !== false,

      // 智能改图页输入框的手动高度（拖动条调的）。0 = 没调过，用 CSS 默认值
      composerH: Number(savedUi.composerH) || 0,

      /* 「我的」页七个区块的展开/折叠。默认只开「API 服务配置」——
         没配 API 之前，那就是唯一必须填的东西；其余都是用过才需要的高级项，
         全展开会把这一页拉得比面板还长，找「清理」要滚半天。 */
      mineOpen: normalizeMineOpen(savedUi.mineOpen)
    }
  };

  if (!state.history || !Array.isArray(state.history)) state.history = [];

  /* 兜底：热更新 / 未来若给 generate 加持久化时，缺字段别把页面炸掉 */
  if (typeof state.generate.quality !== 'string') state.generate.quality = 'auto';
  if (typeof state.edit.quality !== 'string') state.edit.quality = 'auto';
  if (!Array.isArray(state.generate.images)) state.generate.images = [];

  /* 首个会话即当前会话 */
  if (state.sessions.length) {
    state.edit.sessionId = state.sessions[0].id;
    state.edit.messages = state.sessions[0].messages;
    state.edit.model = state.sessions[0].model || '';
  }

  /* 把「插入方式」的开关同步给 ps 层（ps.js 在 store 之前加载，这里一定存在） */
  if (HH.ps && HH.ps.setSmartInsert) HH.ps.setSmartInsert(state.ui.insertSmart);

  /* 记忆路由：从历史「重新编辑」时携带 */
  var pendingIntent = null;

  /* ================= 订阅 ================= */
  var subs = [];
  function subscribe(fn) {
    subs.push(fn);
    return function () {
      var i = subs.indexOf(fn);
      if (i >= 0) subs.splice(i, 1);
    };
  }
  function emit() {
    subs.forEach(function (fn) { try { fn(state); } catch (e) { console.error(e); } });
  }

  /* ================= 持久化：API ================= */
  function persistApi() {
    try {
      localStorage.setItem(K_API, JSON.stringify(state.api));
    } catch (e) {
      console.warn('[store] API 配置保存失败', e);
    }
  }

  /* ================= 持久化：界面偏好 ================= */
  function persistUi() {
    try {
      localStorage.setItem(K_UI, JSON.stringify({
        historyView: state.ui.historyView,
        historyFilter: state.ui.historyFilter,
        insertSmart: state.ui.insertSmart,
        composerH: state.ui.composerH || 0,
        mineOpen: state.ui.mineOpen
      }));
    } catch (e) { /* 忽略 */ }
  }

  /* ================= 持久化：历史图 ================= */
  /**
   * 历史写入：配额不足时逐级降级
   * 1) 先丢弃超出 KEEP_FULL 的 full 原图
   * 2) 再丢弃最老条目的 full
   * 3) 最后删除最老条目
   */
  function persistHistory() {
    var list = state.history.slice(0, MAX_HISTORY);

    function payload(keepFullCount) {
      return list.map(function (e, i) {
        if (i < keepFullCount && e.full) return e;
        var c = Object.assign({}, e);
        delete c.full;
        return c;
      });
    }

    var attempts = [KEEP_FULL, 4, 2, 0];
    for (var a = 0; a < attempts.length; a++) {
      try {
        localStorage.setItem(K_HIST, JSON.stringify(payload(attempts[a])));
        // 回写内存，保持与实际存储一致
        state.history = payload(attempts[a]);
        // 降级到「连原图都存不下」时得让用户知道，否则下次只看到一堆缩略图
        if (attempts[a] < KEEP_FULL) {
          logStore('warn', '历史原图存不下，只留了 ' + attempts[a] + ' 张原图，其余只有缩略图');
        }
        return true;
      } catch (e) {
        if (!/quota/i.test(String(e.name) + String(e.message))) break;
      }
    }

    // 仍未成功：只保留最新 10 条且不含原图
    try {
      var slim = list.slice(0, 10).map(function (e) {
        var c = Object.assign({}, e);
        delete c.full;
        return c;
      });
      localStorage.setItem(K_HIST, JSON.stringify(slim));
      state.history = slim;
      logStore('warn', '历史存不下，只保留了最新 ' + slim.length + ' 条且不含原图');
      return true;
    } catch (e) {
      logStore('error', '历史保存失败：' + String((e && e.message) || e));
      return false;
    }
  }

  /* ================= 持久化：会话 ================= */
  /** 单条消息瘦身：丢掉原图和大数组，只保留可渲染 + 可追溯的字段 */
  function slimMessage(m, withImages) {
    var msgs = {
      id: m.id,
      role: m.role,
      prompt: m.prompt || '',
      model: m.model || '',
      ratio: m.ratio || '',
      status: m.status === 'running' ? 'error' : (m.status || 'done'),
      error: m.error || '',
      // 异步任务号必须留着：面板一收起页面就重载，消息里没有 taskId 的话
      // 「取回结果」按钮会消失，用户只能去后台抄 ID
      taskId: m.taskId || '',
      taskStatus: m.taskStatus || '',
      createdAt: m.createdAt || 0,
      images: [],
      results: []
    };

    (m.images || []).forEach(function (i) {
      // file / thumbFile 是 <dir>/images 里的文件名（几十字节）——
      // 必须留着，否则面板重载后这一轮的参考图就只剩灰块占位了
      var o = {
        id: i.id,
        name: i.name || '',
        w: i.w || 0,
        h: i.h || 0,
        file: i.file || '',
        thumbFile: i.thumbFile || ''
      };
      if (withImages && i.dataUrl && i.dataUrl.length <= MAX_INLINE) o.dataUrl = i.dataUrl;
      msgs.images.push(o);
    });

    (m.results || []).forEach(function (r) {
      var o = {
        id: r.id,
        px: r.px || '',
        size: r.size || '',
        prompt: r.prompt || '',
        model: r.model || '',
        createdAt: r.createdAt || 0,
        file: r.file || '',             // 原图文件名（相对 <dir>/images）
        thumbFile: r.thumbFile || ''    // 缩略图文件名
      };
      if (withImages) {
        // 只内联真正的 base64；file:// URL 存进 JSON 没有意义
        var t = String(r.thumb || r.dataUrl || '');
        if (t.indexOf('data:') === 0 && t.length <= MAX_INLINE) o.thumb = t;
      }
      msgs.results.push(o);
    });

    return msgs;
  }

  function slimSession(sess, withImages) {
    var msgs = (sess.messages || []).slice(-MAX_SESS_MSGS);
    return {
      id: sess.id,
      page: sess.page || 'edit',
      title: sess.title || titleOf(sess),
      createdAt: sess.createdAt || Date.now(),
      updatedAt: sess.updatedAt || Date.now(),
      model: sess.model || '',
      ratio: sess.ratio || '',
      messages: msgs.map(function (m) { return slimMessage(m, withImages); })
    };
  }

  /* ================= 会话元数据（磁盘索引 / 列表渲染共用） ================= */

  function statsOf(msgs) {
    var rounds = 0, images = 0;
    (msgs || []).forEach(function (m) {
      if (m.role === 'user') rounds++;
      images += (m.results || []).length;
    });
    return { rounds: rounds, images: images };
  }

  /** 封面取最后一张结果的缩略图文件，没有就用原图 */
  function coverOf(msgs) {
    for (var i = msgs.length - 1; i >= 0; i--) {
      var rs = msgs[i].results || [];
      for (var j = rs.length - 1; j >= 0; j--) {
        if (rs[j].thumbFile) return rs[j].thumbFile;
        if (rs[j].file) return rs[j].file;
      }
    }
    return '';
  }

  function metaOf(sess) {
    var st = (sess._disk && sess.stats) ? sess.stats : statsOf(sess.messages);
    return {
      id: sess.id,
      page: sess.page || 'edit',
      title: sess.title || titleOf(sess),
      createdAt: sess.createdAt || 0,
      updatedAt: sess.updatedAt || 0,
      model: sess.model || '',
      ratio: sess.ratio || '',
      rounds: st.rounds || 0,
      images: st.images || 0,
      cover: (sess._disk && sess.cover) || coverOf(sess.messages || [])
    };
  }

  /** 只有索引、消息还躺在磁盘上的「壳」会话 */
  function shellFromMeta(m) {
    return {
      id: String(m.id),
      page: m.page === 'generate' ? 'generate' : 'edit',
      title: String(m.title || ''),
      createdAt: Number(m.createdAt) || 0,
      updatedAt: Number(m.updatedAt) || 0,
      model: String(m.model || ''),
      ratio: String(m.ratio || ''),
      messages: [],
      _disk: true,
      stats: { rounds: Number(m.rounds) || 0, images: Number(m.images) || 0 },
      cover: String(m.cover || '')
    };
  }

  /* ================= 持久化：会话 ================= */

  /** 已写盘的会话 id -> updatedAt，避免每次保存都重写全部文件 */
  var diskStamp = {};

  /**
   * 上一次持久化的结果。
   *
   * 以前 persistSessions / persistHistory 的返回值 14 个调用点一个都不接 ——
   * 本地暂存装不下时静默丢掉最老的几段，用户要等下次重启才发现「我的对话没了」。
   * 现在把结果留在这里，由「我的 → 存储位置」显示实话。
   */
  var persistInfo = { mode: '', ok: true, saved: 0, dropped: 0, at: 0, error: '' };

  function notePersist(mode, ok, saved, dropped, error) {
    persistInfo.mode = mode;
    persistInfo.ok = !!ok;
    persistInfo.saved = saved || 0;
    persistInfo.dropped = dropped || 0;
    persistInfo.at = Date.now();
    persistInfo.error = error || '';
  }

  function logStore(level, msg) {
    try { if (HH.diag && HH.diag.log) HH.diag.log(level, 'store', msg); } catch (e) { /* 不许把存盘搞挂 */ }
  }

  /**
   * 会话写入。
   *
   * 磁盘模式（「我的」里设置了资料库目录）：index.json + sessions/<id>.json，
   * 只写变化的那一段，条数不受 localStorage 5MB 限制。
   * 否则退回 localStorage（浏览器预览 / PS 未就绪），最多 LS_SESS 段。
   */
  function persistSessions() {
    var list = state.sessions.slice().sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    if (HH.lib && HH.lib.usable()) return persistToDisk(list);
    return Promise.resolve(persistToLocal(list));
  }

  function persistToDisk(list) {
    var metas = [];
    var writes = [];

    list.forEach(function (sess) {
      var hasMsgs = sess.messages && sess.messages.length;
      if (!hasMsgs && !sess._disk) return;      // 空会话不落盘

      metas.push(metaOf(sess));

      // 壳会话（消息还在磁盘上、尚未加载）不重写文件，否则会把内容清空
      if (sess._disk && !hasMsgs) return;
      if (diskStamp[sess.id] === sess.updatedAt) return;

      diskStamp[sess.id] = sess.updatedAt;
      writes.push(HH.lib.saveSession(slimSession(sess, false)));
    });

    writes.push(HH.lib.writeIndex(metas));

    /* 兜底那份**必须在写盘成功之后**才能删。
       以前是写之前就 removeItem：写盘是异步的，一旦失败（PS 未就绪、目录没了、
       磁盘满），localStorage 那份已经没了、磁盘上也不全 —— 下次启动 readIndex
       读到空，还以为「磁盘上没会话」，两头空，对话全丢。
       现在失败就原样留着兜底，至少下次还能捞回来。 */
    return Promise.all(writes).then(function () {
      try { localStorage.removeItem(K_SESS); } catch (e) { /* 忽略 */ }
      notePersist('disk', true, metas.length, 0);
      return true;
    }, function (e) {
      var msg = String((e && e.message) || e || '未知原因');
      notePersist('disk', false, 0, 0, msg);
      logStore('error', '会话写盘失败，已保留本地暂存那份：' + msg);
      return false;
    });
  }

  /* 上次记进日志的丢弃数，避免每次 commit 都刷一行一样的 */
  var lastDropLogged = -1;

  /**
   * 本地暂存写入。
   *
   * LS_SESS 是「保留上限」不是「丢几段」：list 已按 updatedAt 倒序，slice(0, 8)
   * 无条件切掉第 9 段往后 —— 跟配额无关，装得下也照丢。
   * 所以这里必须把丢了多少算出来、记下来，让界面能说实话。
   */
  function persistToLocal(list) {
    var plans = [
      { n: LS_SESS, img: true },
      { n: 6, img: true },
      { n: 3, img: true },
      { n: LS_SESS, img: false },
      { n: 4, img: false }
    ];

    // 空会话没内容可丢，不该算进「被丢掉」里吓人
    var total = list.filter(function (s) { return s.messages && s.messages.length; }).length;

    for (var i = 0; i < plans.length; i++) {
      var plan = plans[i];
      var payload = list.slice(0, plan.n)
        .map(function (s) { return slimSession(s, plan.img); })
        .filter(function (s) { return s.messages.length; });

      try {
        localStorage.setItem(K_SESS, JSON.stringify(payload));
        return finishLocal(payload.length, total, true, '');
      } catch (e) {
        if (!/quota/i.test(String(e.name) + String(e.message))) {
          return finishLocal(0, total, false, String(e.message || e));
        }
      }
    }

    // 所有档位都装不下：写空数组（等于主动清空）—— 这是最坏的一条路
    try { localStorage.setItem(K_SESS, '[]'); } catch (e) { /* 放弃 */ }
    return finishLocal(0, total, false, 'localStorage 写不进去了');
  }

  function finishLocal(saved, total, ok, error) {
    var dropped = Math.max(0, total - saved);
    notePersist('local', ok, saved, dropped, error);

    if (!ok) {
      logStore('error', '会话保存失败，暂存里只剩 ' + saved + ' 段（共 ' + total + ' 段）：' + error);
    } else if (dropped > 0 && dropped !== lastDropLogged) {
      logStore('warn', '本地暂存只留最近 ' + saved + ' 段，另有 ' + dropped + ' 段没存下（去「我的 → 存储位置」设个文件夹就不限条数）');
    }
    lastDropLogged = dropped;
    return ok;
  }

  /** 删掉一条记录在磁盘上的原图与缩略图 */
  function removeFiles(entry) {
    if (!entry || !HH.ps) return;
    if (entry.file) HH.ps.cacheRemove(entry.file);
    if (entry.thumbFile) HH.ps.cacheRemove(entry.thumbFile);
  }

  /* ================= 会话操作 ================= */
  function findSession(id) {
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === id) return state.sessions[i];
    }
    return null;
  }

  function findHistory(id) {
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].id === id) return state.history[i];
    }
    return null;
  }

  /**
   * 会话里的图被配额清掉后，从 history 找回：
   * - 新记录：history.file 指向磁盘缓存里的原图，只把文件名挂到结果上，用到时再读
   * - 老记录：history.full 里是内联原图，直接塞回 dataUrl
   */
  function hydrateSession(sess) {
    if (!sess || !sess.messages) return sess;
    sess.messages.forEach(function (m) {
      if (m.role !== 'assistant') return;
      (m.results || []).forEach(function (r) {
        var h = findHistory(r.id);
        if (h) {
          if (h.file) r.file = h.file;
          if (h.full) r.dataUrl = h.full;
        }
        if (!r.thumb) r.thumb = (h && h.thumb) || r.dataUrl || '';
      });
    });
    return sess;
  }

  /** 从磁盘把消息读回壳会话 */
  function loadSessionBody(sess) {
    if (!HH.lib || !HH.lib.usable()) {
      sess._disk = false;
      return Promise.resolve(sess);
    }

    return HH.lib.loadSession(sess.id).then(function (data) {
      if (!data) {
        sess.messages = [];
        sess._disk = false;
        return sess;
      }

      var fixed = fixSession(data);
      sess.messages = fixed.messages;
      sess.title = sess.title || fixed.title;
      sess.createdAt = sess.createdAt || fixed.createdAt;
      sess.model = sess.model || fixed.model;
      sess.ratio = sess.ratio || fixed.ratio;
      sess._disk = false;
      sess._loaded = true;
      return sess;
    });
  }

  /** 让 state.edit.messages 始终指向当前会话的消息数组 */
  function ensureSession() {
    var st = state.edit;
    var sess = findSession(st.sessionId);

    if (!sess) {
      sess = {
        id: U.uid('ss'),
        page: 'edit',
        title: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: st.model || '',
        ratio: st.ratio || '1:1',
        messages: []
      };
      state.sessions.unshift(sess);
      st.sessionId = sess.id;
    }

    if (!Array.isArray(sess.messages)) sess.messages = [];

    if (st.messages !== sess.messages) {
      // 内存里有消息但会话是空的（例如从旧版本升上来）→ 收编
      if (st.messages && st.messages.length && !sess.messages.length) {
        sess.messages = st.messages;
      }
      st.messages = sess.messages;
    }

    return sess;
  }

  /** 收尾当前会话：刷新标题 / 时间 / 参数，供列表排序 */
  function touchSession(sess) {
    sess = sess || ensureSession();
    sess.title = titleOf(sess) || sess.title || '';
    sess.updatedAt = Date.now();
    sess.model = state.edit.model || sess.model || '';
    sess.ratio = state.edit.ratio || sess.ratio || '';
    return sess;
  }

  /* ================= 对外 API ================= */
  var store = {
    state: state,

    subscribe: subscribe,
    emit: emit,

    /** 结构性变更：写入并刷新界面 */
    commit: function (mutator) {
      if (typeof mutator === 'function') mutator(state);
      persistApi();
      persistHistory();
      emit();
    },

    /** 静默变更：只改数据，不触发整页重绘（输入框场景） */
    silent: function (mutator) {
      if (typeof mutator === 'function') mutator(state);
    },

    saveApi: function (patch) {
      Object.assign(state.api, patch || {});
      persistApi();
      emit();
    },

    /**
     * 静默写入 API 配置：落盘但不重绘
     * 用于「拉取模型 → 选择模型」这类会打断当前表单的操作
     */
    saveApiSilent: function (patch) {
      Object.assign(state.api, patch || {});
      persistApi();
    },

    resetApi: function () {
      state.api = Object.assign({}, DEFAULT_API);
      persistApi();
      emit();
    },

    /** 模型下拉的候选项：远程拉取优先，其次手填列表，最后主模型 */
    modelOptions: function () {
      var out = [];

      function push(id) {
        id = String(id || '').trim();
        if (id && out.indexOf(id) < 0) out.push(id);
      }

      // 1) 从服务端拉取的模型（生图模型已在拉取时排到前面）
      try {
        var cached = JSON.parse(state.api.modelCache || '[]');
        if (Array.isArray(cached)) {
          cached.forEach(function (m) {
            push(typeof m === 'string' ? m : (m && m.id));
          });
        }
      } catch (e) { /* 缓存损坏则忽略 */ }

      // 2) 手填的常用模型
      String(state.api.modelList || '')
        .split(/[,，\n]/)
        .forEach(push);

      // 3) 当前主模型置顶
      if (state.api.model) {
        var i = out.indexOf(state.api.model);
        if (i > 0) out.splice(i, 1);
        if (i !== 0) out.unshift(state.api.model);
      }

      return out;
    },

    currentModel: function (page) {
      var pageState = page === 'generate' ? state.generate : state.edit;
      return pageState.model || state.api.model || (store.modelOptions()[0] || '');
    },

    /* ---------- 历史 ---------- */
    addHistory: function (entry) {
      state.history.unshift(entry);

      // 超出上限的老条目：连磁盘上的原图一起清掉，否则缓存目录只增不减
      var dropped = [];
      if (state.history.length > MAX_HISTORY) {
        dropped = state.history.slice(MAX_HISTORY);
        state.history.length = MAX_HISTORY;
      }

      persistHistory();
      dropped.forEach(function (e) {
        removeFiles(e);
      });
    },

    removeHistory: function (id) {
      var old = findHistory(id);
      state.history = state.history.filter(function (e) { return e.id !== id; });
      persistHistory();
      // 顺手删掉磁盘上的原图与缩略图，避免缓存目录越攒越大
      if (old) removeFiles(old);
      emit();
    },

    clearHistory: function () {
      var old = state.history.slice();
      state.history = [];
      persistHistory();
      old.forEach(removeFiles);
      emit();
    },

    findHistory: findHistory,

    /* ---------- 会话 ---------- */
    /** 当前会话对象（不存在则创建，但不落盘） */
    ensureSession: ensureSession,

    findSession: findSession,

    currentSession: function () {
      return findSession(state.edit.sessionId) || ensureSession();
    },

    touchSession: function (sess) {
      return touchSession(sess);
    },

    /** 会话里至少有内容的才展示 / 落盘（磁盘上的壳也算） */
    activeSessions: function () {
      return state.sessions.filter(function (s) {
        return (s.messages && s.messages.length) || s._disk;
      }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    },

    /** 标题：首条用户提示词压缩成一行 */
    sessionTitle: function (sess) {
      return (sess && (sess.title || titleOf(sess))) || '未命名对话';
    },

    /** 会话封面：返回图片文件名或 base64（渲染层用 U.lazyImg 处理） */
    sessionCover: function (sess) {
      if (!sess) return '';
      if (sess._disk && sess.cover) return sess.cover;

      var msgs = sess.messages || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        var rs = msgs[i].results || [];
        for (var j = rs.length - 1; j >= 0; j--) {
          var r = rs[j];
          if (r.thumb) return r.thumb;
          if (r.thumbFile) return r.thumbFile;
          if (r.file) return r.file;
          if (r.dataUrl) return r.dataUrl;
        }
      }
      return '';
    },

    /** 会话统计：轮数 / 图片数（壳会话直接用索引里的数字） */
    sessionStats: function (sess) {
      if (sess && sess._disk && sess.stats) return sess.stats;
      return statsOf((sess && sess.messages) || []);
    },

    saveSessions: persistSessions,
    hydrateSession: hydrateSession,
    saveUi: persistUi,

    /** 「我的」页区块默认展开/折叠表（给渲染层做兜底，也便于测试对齐） */
    mineSectionKeys: function () { return Object.keys(MINE_SECTIONS); },

    /**
     * 切换「插入图层用智能对象」开关
     * @param {boolean} v
     */
    setInsertSmart: function (v) {
      state.ui.insertSmart = !!v;
      if (HH.ps && HH.ps.setSmartInsert) HH.ps.setSmartInsert(!!v);
      persistUi();
    },

    /**
     * 开一个新对话：当前会话原样留在「对话记录」里，页面清空
     */
    newSession: function () {
      touchSession();
      persistSessions();

      state.edit.sessionId = '';
      state.edit.messages = [];
      var sess = ensureSession();
      persistSessions();
      return sess;
    },

    /**
     * 打开历史对话（生成中不允许切换，否则消息会丢到旧数组里）
     *
     * 磁盘上的壳会话会先把 sessions/<id>.json 读回来，所以返回 Promise。
     */
    openSession: function (id) {
      if (state.edit.running) return Promise.resolve(null);

      var sess = findSession(id);
      if (!sess) return Promise.resolve(null);

      var ready = (sess._disk && !(sess.messages || []).length)
        ? loadSessionBody(sess)
        : Promise.resolve(sess);

      return ready.then(function (s) {
        if (!s) return null;

        hydrateSession(s);
        state.edit.sessionId = s.id;
        state.edit.messages = s.messages;
        state.edit.prompt = '';
        state.edit.images = [];
        if (s.model) state.edit.model = s.model;
        if (s.ratio) state.edit.ratio = s.ratio;

        emit();
        return s;
      });
    },

    removeSession: function (id) {
      var before = state.sessions.length;
      state.sessions = state.sessions.filter(function (s) { return s.id !== id; });
      if (before === state.sessions.length) return;

      if (state.edit.sessionId === id) {
        state.edit.sessionId = '';
        state.edit.messages = [];
        ensureSession();
      }

      delete diskStamp[id];
      if (HH.lib && HH.lib.usable()) HH.lib.deleteSession(id);

      persistSessions();
      emit();
    },

    /** 把还躺在磁盘上的会话全部读进内存（切换存储目录前调用） */
    loadAllSessions: function () {
      var shells = state.sessions.filter(function (s) {
        return s._disk && !(s.messages || []).length;
      });
      return Promise.all(shells.map(function (s) { return loadSessionBody(s); }));
    },

    /** 强制把全部会话重写一遍（切换目录 / 重建索引） */
    rewriteLibrary: function () {
      diskStamp = {};
      return persistSessions();
    },

    /** 清空全部对话（磁盘文件一起删，保留当前正在编辑的这一段） */
    clearSessions: function () {
      var keep = state.edit.sessionId;
      state.sessions = state.sessions.filter(function (s) { return s.id === keep; });
      diskStamp = {};

      var done = (HH.lib && HH.lib.usable())
        ? HH.lib.clearSessions().then(function () { return persistSessions(); })
        : Promise.resolve(persistSessions());

      emit();
      return done;
    },

    /**
     * 老版本记录（没有 sessionId）按图片逆推出一个单轮会话，
     * 这样升级前生成的结果也能双击回看
     */
    buildLegacySession: function (entry) {
      if (!entry) return null;
      var t = entry.createdAt || Date.now();
      var sess = {
        id: 'ss_legacy_' + entry.id,
        page: entry.page || 'edit',
        title: '', 
        createdAt: t,
        updatedAt: t,
        model: entry.model || '',
        ratio: '',
        messages: [
          {
            id: U.uid('m'),
            role: 'user',
            prompt: entry.prompt || '',
            images: entry.srcThumb
              ? [{ id: U.uid('img'), dataUrl: entry.srcThumb, name: '参考图' }]
              : [],
            createdAt: t
          },
          {
            id: U.uid('m'),
            role: 'assistant',
            status: 'done',
            prompt: entry.prompt || '',
            model: entry.model || '',
            createdAt: t,
            results: [{
              id: entry.id,
              dataUrl: entry.full || '',
              file: entry.file || '',
              thumb: entry.thumb || entry.full || '',
              px: '',
              size: entry.size || '',
              prompt: entry.prompt || '',
              model: entry.model || '',
              createdAt: t
            }]
          }
        ]
      };
      sess.title = titleOf(sess);
      state.sessions.unshift(sess);

      // 顺手把老记录挂到新会话上，下次直接命中
      entry.sessionId = sess.id;
      persistHistory();
      persistSessions();
      return sess;
    },

    /* ---------- 跨页意图（重新编辑 / 打开对话） ---------- */
    setIntent: function (intent) { pendingIntent = intent; },
    takeIntent: function () {
      var i = pendingIntent;
      pendingIntent = null;
      return i;
    },

    DEFAULT_API: DEFAULT_API,
    KEEP_FULL: KEEP_FULL,
    MAX_HISTORY: MAX_HISTORY,
    KEEP_SESS: KEEP_SESS,
    LS_SESS: LS_SESS,

    /** 上次持久化的结果，供「我的 → 存储位置」显示实话 */
    persistInfo: function () { return persistInfo; }
  };

  /* 启动时给所有会话补齐图片（配额降级过的会话靠 history 找回） */
  state.sessions.forEach(hydrateSession);
  if (state.sessions.length) ensureSession();

  HH.store = store;

  /* ================= 启动：接上磁盘资料库 ================= */
  var bootTimer = setTimeout(bootLibrary, 60);

  function bootLibrary() {
    clearTimeout(bootTimer);
    if (!HH.lib || !HH.lib.available()) return;   // 浏览器预览：维持 localStorage 模式

    HH.lib.init()
      .then(function (ok) {
        if (!ok) return [];
        return HH.lib.readIndex();
      })
      .then(function (metas) {
        if (!metas || !metas.length) {
          // 磁盘上还没有会话：把 localStorage 里的老数据迁过去
          if (state.sessions.length) persistSessions();
          return;
        }
        mergeDiskSessions(metas);
      })
      .catch(function (e) { console.warn('[store] 资料库初始化失败', e); });
  }

  /** 磁盘索引 + 内存会话 合并（同 id 优先保留已加载的那份） */
  function mergeDiskSessions(metas) {
    var seen = {};
    var merged = [];

    metas.forEach(function (m) {
      seen[m.id] = true;
      var local = findSession(m.id);

      if (local && local.messages && local.messages.length) {
        // 本地已有完整消息（localStorage 迁移过来的）→ 保留，别换成空壳
        if ((m.updatedAt || 0) >= (local.updatedAt || 0)) {
          local.updatedAt = m.updatedAt || local.updatedAt;
          local.title = m.title || local.title;
        }
        merged.push(local);
      } else {
        merged.push(shellFromMeta(m));
      }
    });

    // 内存里独有的会话（还没落盘）也留着
    state.sessions.forEach(function (s) {
      if (!seen[s.id]) merged.push(s);
    });

    state.sessions = merged.sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    /* 当前会话如果被换成了壳，把指针重新指过去。
       磁盘模式下会话列表只有壳（id/标题/时间），消息体在各自己的 json 里，
       不读回来主界面就是一段空对话 —— 面板一收起就会重载，用户会以为「聊天记录没了」。 */
    var cur = findSession(state.edit.sessionId);
    if (!cur && state.sessions.length) {
      cur = state.sessions[0];
      state.edit.sessionId = cur.id;
      if (cur.model) state.edit.model = cur.model;
    }
    if (cur) state.edit.messages = cur.messages;

    emit();

    // 启动时页面已经先渲染过一次（那时还没有磁盘数据），这里补一次重绘
    if (HH.app && HH.app.refresh) HH.app.refresh();

    // 空壳 → 读消息体 → 再重绘一次（异步，读盘几十毫秒）
    if (cur && (!cur.messages || !cur.messages.length)) {
      loadSessionBody(cur).then(function () {
        if (state.edit.sessionId !== cur.id) return;   // 期间用户切了别的会话
        state.edit.messages = cur.messages;
        emit();
        if (HH.app && HH.app.refresh) HH.app.refresh();
      });
    }
  }

})(window);
