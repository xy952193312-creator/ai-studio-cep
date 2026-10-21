/**
 * pages/edit.js — 智能改图（对话流）
 *
 * 布局：固定页头 → 可滚动消息区 → 固定输入区
 * 一次生成 = 一条用户消息（参考图 + 描述）+ 一条 AI 回复（结果图 + 操作）
 *
 * 参考图来源有两种：
 *   1. 读取 PS 当前选区（jsx/host.jsx 的 __aiGetSelection）
 *   2. 本地上传 / 拖拽 / 粘贴
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util, S = HH.store, UI = HH.ui;

  var RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];
  var COUNTS = [1, 2, 3, 4];
  var MAX_PROMPT = HH.MAX_PROMPT;   // 两页共用一份，别再各自写死
  /* 与「AI 生图」保持一致（那边有完整的实测依据，见 FINDINGS.md）。
     改图这里第一张是「被改的那张」，后面是参考图，
     顺序同样有主次 —— 拖动排序才能让用户决定哪张当主图。 */
  /* 上限 9：传 10 张会被服务端 400 拒（实测见 generate.js 同名注释）。
     两页必须一致，否则用户会觉得「这边能选 10 张、那边只能选 9 张」。 */
  var MAX_IMAGES = 9;

  /* 同 generate.js：9 只是默认值，服务端纠正过就以服务端为准（只降不升） */
  function cap() {
    var n = (HH.api && HH.api.refLimit) ? HH.api.refLimit() : 0;
    return (n > 0 && n < MAX_IMAGES) ? n : MAX_IMAGES;
  }

  /* 上限被压小之前用户可能已经选满了旧上限那么多张：提交前自己收一次并说明 */
  function clampImages(s) {
    var n = cap();
    if (!s.images || s.images.length <= n) return false;
    s.images = s.images.slice(0, n);
    return true;
  }

  /* 输入框高度：拖动条可调，记在本机。
     下限取 56 而不是 54：textarea 默认两行的自然高度就是 56
     （padding 8×2 + border 1×2 + 行高 19×2，box-sizing 是 border-box）。
     对齐它，复位前后才不会有 2px 的跳动。 */
  var COMPOSER_MIN_H = 56;
  var COMPOSER_MAX_RATIO = 0.7;     // 最高占到面板七成，再多消息区就没了
  var COMPOSER_KEEP_MSG = 80;       // 拖动时至少给消息区留这么多像素

  HH.pages = HH.pages || {};

  /**
   * 生成期间面板是否被收起/隐藏过。
   *
   * CEP 面板点右上角 » 收起后，PS 会把面板页面冻结，页面里正在等待的 fetch 会被
   * 直接取消 —— 报错只有 "Failed to fetch"，但服务端那次调用早跑完了（照扣费），
   * 只是响应送不回来。记这个标记，是为了失败时能把真实原因讲清楚。
   */
  var hiddenDuringRun = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && S.state.edit && S.state.edit.running) hiddenDuringRun = true;
  });

  /* ---------------- 工具 ---------------- */
  function sizeLabel(ratio) {
    return HH.api.ratioToSize(ratio).replace('x', '×');
  }

  /**
   * 质量档位下拉（参数条里的一个 mini select）
   * 只有当前模型认 quality 时才出现，否则返回空串 —— 这一条和 AI 生图页同源，
   * 都走 api.qualityOptions，避免两页各写一份规则、以后一家改了另一家没改。
   */
  function qualitySelectHTML() {
    var model = S.currentModel('edit');
    var list = HH.api.qualityOptions(model);
    if (!list) return '';
    var cur = HH.api.normalizeQuality(model, S.state.edit.quality);
    return '<select class="select-native chat-mini chat-quality" id="editQuality" title="生图质量">' +
      list.map(function (q) {
        return '<option value="' + q + '"' + (q === cur ? ' selected' : '') + '>' +
          (HH.api.QUALITY_LABEL[q] || q) + '</option>';
      }).join('') +
    '</select>';
  }

  /** 换模型后就地增删/更新质量下拉，不整页重挂（对话流重挂会丢滚动位置） */
  function syncQualitySelect() {
    var s = S.state.edit;
    var el = U.$('#editQuality');
    var list = HH.api.qualityOptions(S.currentModel('edit'));

    if (!list) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }

    var cur = HH.api.normalizeQuality(S.currentModel('edit'), s.quality);
    var opts = list.map(function (q) {
      return '<option value="' + q + '"' + (q === cur ? ' selected' : '') + '>' +
        (HH.api.QUALITY_LABEL[q] || q) + '</option>';
    }).join('');

    if (el) el.innerHTML = opts;
    else {
      var cnt = U.$('#editCount');
      if (cnt) cnt.insertAdjacentHTML('afterend', qualitySelectHTML());
    }
    s.quality = cur;
  }

  function findMsg(id) {
    var list = S.state.edit.messages;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function findResultInMsg(msg, id) {
    if (!msg || !msg.results) return null;
    for (var i = 0; i < msg.results.length; i++) if (msg.results[i].id === id) return msg.results[i];
    return null;
  }

  /**
   * 把用户消息里的参考图写进资料库 images 目录，并在消息里记下文件名。
   *
   * 会话写盘时只保留「文件名」（base64 太大，5MB 配额撑不住），
   * 所以图片本体必须先落盘，否则面板重载后那一轮对话只剩灰块占位。
   *
   * @param {object} msg   用户消息（images 里会被补上 file）
   * @param {string[]} light 320px 的压缩图（dataURL），落盘用这个就够
   * @param {object[]} origin 原始图片项（兜底取 dataUrl）
   * @param {object} sess  所属会话（写完再存一次，把 file 带进 JSON）
   */
  function persistRefs(msg, light, origin, sess) {
    if (!msg || !msg.images || !msg.images.length) return Promise.resolve();
    if (!HH.ps || !HH.ps.persistImage) return Promise.resolve();

    var jobs = msg.images.map(function (im, idx) {
      var d = (light && light[idx]) || (origin[idx] && origin[idx].dataUrl) || '';
      if (!d || String(d).indexOf('data:') !== 0) return Promise.resolve();
      return HH.ps.persistImage(im.id, d).then(function (st) {
        if (st && st.file) im.file = st.file;
      }).catch(function () { /* 落盘失败就退回内存图，不影响本次生成 */ });
    });

    return Promise.all(jobs).then(function () {
      if (sess) { S.touchSession(sess); S.saveSessions(); }
    });
  }

  /**
   * 取这条 AI 回复所用的参考图
   *
   * 内存里的消息有 refImages（720px，回填质量好）；
   * 从 localStorage 读回来的会话为了省配额会把 refImages 裁掉，
   * 这时往前找最近一条带图的用户消息兜底 —— 否则「再次生成」会报「请先上传图片」。
   */
  /**
   * 取这条 AI 回复所用的参考图「原始项」。
   * 内存里是 dataURL 字符串；从磁盘恢复的会话里是 { id, name, w, h, file } 对象。
   */
  function refItems(msg) {
    if (msg.refImages && msg.refImages.length) return msg.refImages.slice();

    var list = S.state.edit.messages || [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i] !== msg) continue;
      for (var j = i - 1; j >= 0; j--) {
        var prev = list[j];
        if (prev.role !== 'user' || !prev.images || !prev.images.length) continue;
        return prev.images.slice();
      }
      break;
    }
    return [];
  }

  /**
   * 把参考图项解析成 dataURL。
   * 面板收起会重载页面，内存里的 base64 没了、只剩 file 文件名 ——
   * 这时从 <dir>/images 读回来，「再次生成 / 重新编辑」才不会丢图。
   */
  function loadRefs(msg) {
    return Promise.all(refItems(msg).map(function (it) {
      if (!it) return Promise.resolve('');
      if (typeof it === 'string') return Promise.resolve(it);
      if (it.dataUrl) return Promise.resolve(it.dataUrl);
      if (HH.ps && HH.ps.resolveImage) {
        return HH.ps.resolveImage(it).catch(function () { return ''; });
      }
      return Promise.resolve('');
    })).then(function (arr) { return arr.filter(Boolean); });
  }

  function scrollBottom() {
    var box = U.$('#chatBody');
    if (box) box.scrollTop = box.scrollHeight;
  }

  /** 当前会话已聊了几轮（= 用户消息条数） */
  function roundCount() {
    return (S.state.edit.messages || []).filter(function (m) { return m.role === 'user'; }).length;
  }

  function sessTagHTML() {
    var n = roundCount();
    if (!n) return '<span class="chat-sess is-new">新对话</span>';
    return '<span class="chat-sess">第 ' + n + ' 轮</span>';
  }

  function renderSessTag() {
    var el = U.$('.chat-title .chat-sess');
    if (el) el.outerHTML = sessTagHTML();
  }

  /** 定位到某张结果图（历史对话回看用） */
  function focusResult(id) {
    var box = U.$('#chatBody');
    if (!box) return;
    var figs = box.querySelectorAll('[data-id="' + id + '"]');
    var fig = figs.length ? figs[figs.length - 1] : null;
    if (!fig) return;
    try { fig.scrollIntoView({ block: 'center' }); } catch (e) { /* 老内核忽略 */ }
    fig.classList.add('is-focus');
    setTimeout(function () { fig.classList.remove('is-focus'); }, 2200);
  }

  /* ---------------- 渲染：整页 ---------------- */
  function render() {
    var s = S.state.edit;
    var models = S.modelOptions();
    var model = s.model || S.state.api.model || models[0] || '';

    var modelSelect = models.length
      ? '<select class="select-native chat-model" id="editModel">' + UI.options(models, model) + '</select>'
      : '<input class="input chat-model" id="editModel" placeholder="未配置模型">';

    return '' +
    '<div class="page chat" id="editPage">' +

      /* ===== 固定页头 ===== */
      '<div class="chat-head">' +
        '<div class="chat-head-row">' +
          '<span class="chat-title">智能改图' + sessTagHTML() + '</span>' +
          '<span class="chat-head-actions">' +
            '<button class="btn btn-sm btn-ghost" data-act="newChat" title="开启一个新的对话窗口（当前对话会存进历史）">新对话</button>' +
            '<button class="btn btn-sm btn-ghost" data-go="history">历史</button>' +
          '</span>' +
        '</div>' +
        '<div class="chat-head-row chat-params">' +
          modelSelect +
          '<select class="select-native chat-mini" id="editRatio" title="输出比例">' +
            RATIOS.map(function (r) {
              return '<option value="' + r + '"' + (r === s.ratio ? ' selected' : '') + '>' + r + '</option>';
            }).join('') +
          '</select>' +
          '<select class="select-native chat-mini" id="editCount" title="生成张数">' +
            COUNTS.map(function (n) {
              return '<option value="' + n + '"' + (n === s.count ? ' selected' : '') + '>' + n + ' 张</option>';
            }).join('') +
          '</select>' +
          qualitySelectHTML() +
        '</div>' +
      '</div>' +

      /* ===== 消息区 ===== */
      '<div class="chat-body" id="chatBody"></div>' +

      /* ===== 固定输入区 ===== */
      '<div class="chat-composer" id="composer">' +
        /* 拖动条：向上拖变高、向下拖变矮。CEF 原生 textarea 拖柄在这么窄的
           面板里几乎点不中，所以自己做一个更好按的 */
        '<div class="composer-grip" id="editGrip" title="拖动调整输入框高度"></div>' +
        '<div class="composer-thumbs" id="editThumbs"></div>' +
        '<div class="composer-tools">' +
          '<button class="btn btn-sm" data-act="pickSel" title="读取 Photoshop 当前选区">' +
            UI.I.select + '读取选区</button>' +
          '<button class="btn btn-sm" data-act="pickFile">' + UI.I.upload + '上传本地</button>' +
          '<input type="file" id="editFile" accept="image/*" multiple hidden>' +
        '</div>' +
        '<textarea class="textarea composer-input" id="editPrompt" maxlength="' + MAX_PROMPT + '" ' +
          'spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" ' +
          'placeholder="描述你想要的修改…">' +
          U.escapeHTML(s.prompt) + '</textarea>' +
        '<div class="composer-foot">' +
          '<span class="composer-count" id="editPromptCount">' + s.prompt.length + '/' + MAX_PROMPT + '</span>' +
          '<button class="btn btn-primary" id="editRun">生成</button>' +
        '</div>' +
      '</div>' +

    '</div>';
  }

  /* ---------------- 渲染：消息 ---------------- */
  function renderMsg(m) {
    if (m.role === 'user') {
      /* 参考图：hover 出现「预览 / 下载」两个图标按钮 */
      var figs = (m.images || []).map(function (i, idx) {
        // 优先内存里的 dataURL；面板重载后只剩文件名，交给 U.lazyImg 异步读回来
        var src = i.dataUrl || i.thumbFile || i.file || '';
        if (!src) {
          // 老记录：参考图当年没存下来（体积超限被丢），显示占位而不是破图
          return '<figure class="msg-thumb is-empty" title="参考图未保存">' +
            '<span class="msg-thumb-tip">参考图</span>' +
          '</figure>';
        }
        return '<figure class="msg-thumb">' +
          '<img ' + U.lazyImg(src) + ' alt="' + U.escapeHTML(i.name || '参考图') + '">' +
          '<div class="thumb-mask">' +
            '<button class="ico-btn" data-act="previewSrc" data-idx="' + idx + '" title="预览">' +
              UI.I.search + '</button>' +
            '<button class="ico-btn" data-act="downloadSrc" data-idx="' + idx + '" title="下载">' +
              UI.I.download + '</button>' +
          '</div>' +
        '</figure>';
      }).join('');

      return '<div class="msg msg-user" data-mid="' + m.id + '">' +
        '<div class="msg-bubble">' +
          (figs ? '<div class="msg-imgs">' + figs + '</div>' : '') +
          '<div class="msg-text">' + U.escapeHTML(m.prompt) + '</div>' +
        '</div>' +
      '</div>';
    }

    var body = '';

    if (m.status === 'running') {
      body = '<div class="msg-loading"><span class="spinner"></span>正在生成，预计 40-60 秒' +
        '<span class="msg-loading-note">期间别收起面板</span></div>';
    } else if (m.status === 'pending') {
      /* 异步任务：服务端还在跑（或已经跑完但没取回）。
         这里明确告诉用户可以随便折叠面板，别再傻等也别重复提交。 */
      var pg = String(m.progress || '').trim();
      var stTxt = m.taskStatus === 'completed' ? '已出图，正在取回…'
        : (m.taskStatus === 'in_progress' ? '服务端生成中' : '已提交，排队中');
      body = '<div class="msg-loading"><span class="spinner"></span>' +
        stTxt + (pg ? ' · ' + U.escapeHTML(pg) : '') +
        '<span class="msg-loading-note">任务 ' + U.escapeHTML(String(m.taskId || '').slice(-6)) +
        ' · 这期间可以随便收起面板</span></div>' +
        (m.error ? '<div class="msg-error">' + U.escapeHTML(m.error) + '</div>' : '') +
        '<div class="msg-actions">' +
          (m.taskId ? '<button class="btn btn-sm" data-act="fetchTask" data-tid="' + U.escapeHTML(m.taskId) + '">取回结果</button>' : '') +
          '<button class="btn btn-sm" data-act="copyTask">复制任务 ID</button>' +
        '</div>';
    } else if (m.status === 'error') {
      body = '<div class="msg-error">' + U.escapeHTML(m.error || '生成失败') + '</div>';
    } else {
      /* 结果图：hover 出大面积「插入图层」遮罩 + 底部预览/下载 */
      body = '<div class="msg-results">' + (m.results || []).map(function (it) {
        // 角标如实反映「这张还存没存原图」：
        // 老记录的 full 被旧代码换成了 360 缩略图，px 字段却还写着 1024×1024，
        // 直接显示会让人以为插进去的是高清原图，实际会被放大到很糊。
        var hasFull = !!(it.file || it.dataUrl || it.full);
        var sizeCls = 'msg-size' + (hasFull ? '' : ' is-warn');
        var sizeTxt = hasFull ? (it.px || it.size || '') : '仅缩略图';

        return '<figure class="msg-result" data-id="' + U.escapeHTML(it.id) + '">' +
          '<img ' + U.lazyImg(it.thumb || it.thumbFile || it.file || it.dataUrl) + ' alt="结果图">' +
          (sizeTxt ? '<span class="' + sizeCls + '">' + U.escapeHTML(sizeTxt) + '</span>' : '') +
          '<div class="result-mask">' +
            '<button class="mask-insert" data-act="insert" title="插入到当前文档的新图层">' +
              '<span class="mask-plus">' + UI.I.plus + '</span>' +
              '<span class="mask-label">插入图层</span>' +
            '</button>' +
            '<div class="mask-foot">' +
              '<button class="mask-btn" data-act="preview">预览</button>' +
              '<button class="mask-btn" data-act="download">下载</button>' +
            '</div>' +
          '</div>' +
        '</figure>';
      }).join('') + '</div>' +
      '<div class="msg-actions">' +
        '<button class="btn btn-sm" data-act="reedit">重新编辑</button>' +
        '<button class="btn btn-sm btn-primary-sm" data-act="regen">再次生成</button>' +
      '</div>';
    }

    return '<div class="msg msg-ai" data-mid="' + m.id + '">' +
      '<div class="msg-avatar">AI</div>' +
      '<div class="msg-bubble">' + body + '</div>' +
    '</div>';
  }

  function renderMessages() {
    var box = U.$('#chatBody');
    if (!box) return;

    var msgs = S.state.edit.messages;
    if (!msgs.length) {
      box.innerHTML = UI.empty('开始第一次改图', '读取 PS 选区或上传图片，写下想要的修改，点「生成」');
      return;
    }
    box.innerHTML = msgs.map(renderMsg).join('');
  }

  /* ---------------- 渲染：输入区 ---------------- */
  function renderThumbs() {
    var strip = U.$('#editThumbs');
    if (!strip) return;
    var images = S.state.edit.images;
    if (!images.length) { strip.innerHTML = ''; strip.hidden = true; return; }
    strip.hidden = false;
    // 第一张是「被改的那张」，标出来，和 AI 生图页的「底图」同一套逻辑
    HH.uploader.renderStrip(strip, images, '主图');
  }

  function renderPromptMeta() {
    var el = U.$('#editPromptCount');
    if (el) el.textContent = S.state.edit.prompt.length + '/' + MAX_PROMPT;
  }

  function renderRunState() {
    var btn = U.$('#editRun');
    if (!btn) return;
    var running = S.state.edit.running;
    btn.disabled = running;
    btn.textContent = running ? '生成中…' : '生成';
  }

  /* ---------------- 输入框高度：拖动条 ---------------- */

  /** 上限随面板高度变化，不能写死——面板拉高后输入区也该能更高 */
  function composerMaxH() {
    var host = U.$('#view') || document.body;
    var pageH = (host && host.clientHeight) || 600;
    return Math.max(COMPOSER_MIN_H,
      Math.floor(pageH * COMPOSER_MAX_RATIO) - COMPOSER_KEEP_MSG);
  }

  function clampComposerH(h) {
    return Math.min(composerMaxH(), Math.max(COMPOSER_MIN_H, Math.round(h)));
  }

  /**
   * 绑定拖动条。
   *
   * 用 pointer 事件而不是 mouse：CEP 面板在触摸屏 / 数位屏上也要能用，
   * 而 mouse 事件在触摸设备上不会派发。
   * 拖动期间给 body 加 is-resizing（禁选中 + 改光标），否则会一边拖一边刷蓝一片文字。
   */
  function bindComposerResize() {
    var grip = U.$('#editGrip');
    var ta = U.$('#editPrompt');
    if (!grip || !ta) return;

    /* 恢复上次调过的高度 */
    var saved = S.state.ui.composerH;
    if (saved) ta.style.height = clampComposerH(saved) + 'px';

    var dragging = false;
    var startY = 0;
    var startH = 0;

    function onMove(e) {
      if (!dragging) return;
      // 向上拖（clientY 变小）= 变高
      ta.style.height = clampComposerH(startH + (startY - e.clientY)) + 'px';
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      try { document.body.classList.remove('is-resizing'); } catch (e) {}

      var h = parseInt(ta.style.height, 10);
      if (!h) return;
      S.state.ui.composerH = h;
      if (S.saveUi) S.saveUi();      // 记在本机，下次打开还是这个高度
    }

    grip.addEventListener('pointerdown', function (e) {
      e.preventDefault();           // 不让浏览器顺手选中文字
      dragging = true;
      startY = e.clientY;
      startH = ta.offsetHeight;     // offsetHeight 读的是实际渲染高度，比 style 里的准
      try { document.body.classList.add('is-resizing'); } catch (e2) {}
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });

    /* 双击复位：调乱了能一键回到默认 */
    grip.addEventListener('dblclick', function () {
      ta.style.height = '';
      S.state.ui.composerH = 0;
      if (S.saveUi) S.saveUi();
      UI.toast('输入框高度已复位', 'ok');
    });
  }

  /* ---------------- 读取 PS 选区 ---------------- */
  // 按钮常态文案固定，不依赖运行时快照：否则一旦某次异常，按钮会永久卡在「读取中…」
  var PICK_IDLE_HTML = UI.I.select + '读取选区';

  function pickSelection(btn) {
    // 具体取图逻辑在 HH.uploader.pickSelection —— 与「AI 生图」页共用同一份，
    // 保证两边的上限提示、失败文案、按钮恢复行为完全一致
    HH.uploader.pickSelection({
      btn: btn,
      getIdle: function () { return PICK_IDLE_HTML; },
      getImages: function () { return S.state.edit.images; },
      addImage: function (it) { S.state.edit.images.push(it); },
      max: cap(),
      maxMsg: '最多 ' + cap() + ' 张参考图，先删掉一张再读',
      onChange: renderThumbs
    });
  }

  /* ---------------- 生成 ---------------- */
  function run() {
    var s = S.state.edit;
    if (s.running) return;

    var promptText = String(s.prompt || '').trim();
    if (!promptText) {
      UI.toast('请先描述你想要的修改', 'error');
      var ta = U.$('#editPrompt');
      if (ta) ta.focus();
      return;
    }
    if (!s.images.length) {
      UI.toast('请先读取选区或上传图片', 'error');
      return;
    }

    /* 同 generate.js：上限被服务端压小后，先把已选的收到新上限，别静默丢图 */
    if (clampImages(s)) {
      renderThumbs();
      UI.toast('服务端当前最多 ' + cap() + ' 张，已只保留前 ' + cap() + ' 张', 'warn');
    }

    var model = S.currentModel('edit');
    var ratio = s.ratio;
    var count = s.count;
    var negative = String(s.negative || '').trim();
    var sendImages = s.images.slice();
    // 先把档位收敛到该模型支持的范围：切模型后旧值可能已经失效
    s.quality = HH.api.normalizeQuality(model, s.quality);

    // 每条消息都要落进当前会话；没有会话就在这里建一个
    var sess = S.ensureSession();
    var sessId = sess.id;

    s.running = true;
    renderRunState();

    // 消息里存压缩图：显示用 320，回填用 720；接口仍用原图
    var lightP = Promise.all(sendImages.map(function (i) {
      return U.thumb(i.dataUrl, 320, 0.72).catch(function () { return i.dataUrl; });
    }));
    var refP = Promise.all(sendImages.map(function (i) {
      return U.thumb(i.dataUrl, 720, 0.82).catch(function () { return i.dataUrl; });
    }));

    Promise.all([lightP, refP]).then(function (pair) {
      var light = pair[0];
      var refs = pair[1];

      var userMsg = {
        id: U.uid('mu'),
        role: 'user',
        prompt: promptText,
        images: sendImages.map(function (i, idx) {
          return { id: i.id, dataUrl: light[idx], name: i.name || '', w: i.w || 0, h: i.h || 0 };
        }),
        createdAt: Date.now()
      };
      s.messages.push(userMsg);

      var aiMsg = {
        id: U.uid('ma'),
        role: 'assistant',
        status: 'running',
        prompt: promptText,
        model: model,
        ratio: ratio,
        results: [],
        refImages: refs,
        createdAt: Date.now()
      };
      s.messages.push(aiMsg);

      // 清空输入区（图已经在消息里了）
      s.prompt = '';
      s.images = [];
      renderThumbs();
      renderPromptMeta();
      renderMessages();
      scrollBottom();

      // 先把「用户消息 + 生成中」写盘，面板中途关掉也能在历史里看到这一轮
      S.touchSession(sess);
      S.saveSessions();

      /* 参考图也落盘。
         为什么必须在提交后立刻做：面板一收起，PS 会重建 CEP 视图（等于整页重载），
         内存里的 base64 全丢；会话写盘时又只留「文件名」，于是重载后
         那一轮的用户消息只剩两个写着「参考图」的灰块。
         写盘后消息里带上 file 字段，重载时照样能读出来。
         存 720px 那份：屏幕上的缩略图用内存里的 320px，磁盘这份负责预览 / 下载 / 再次生成。 */
      persistRefs(userMsg, refs, sendImages, sess);

      var label = sizeLabel(ratio);
      var reqOpts = {
        mode: 'edit',
        prompt: promptText,
        negative: negative,
        model: model,
        ratio: ratio,
        count: count,
        quality: s.quality,     // 由 api.js 按模型收敛，不认这字段的模型会被丢弃
        images: sendImages.map(function (i) { return i.dataUrl; })
      };

      /* 把「图片地址 -> 结果卡片」这一段抽出来，同步/异步/断点续取三条路共用 */
      function finish(urls, isMock) {
        return urls.reduce(function (chain, url) {
          return chain.then(function (acc) {
            // 逐张生成缩略图，避免一次性占满内存
            return Promise.all([
              U.thumb(url, 360, 0.72).catch(function () { return url; }),
              U.thumb(url, 360, 0.72).catch(function () { return url; }),
              U.imageSize(url).catch(function () { return { w: 0, h: 0 }; })
            ]).then(function (t) {
              acc.push({
                id: U.uid('g'),
                dataUrl: url,
                thumb: t[0],
                px: t[2].w ? (t[2].w + '×' + t[2].h) : '',
                size: label,
                prompt: promptText,
                model: model,
                createdAt: Date.now()
              });
              return acc;
            });
          });
        }, Promise.resolve([])).then(function (items) {
          aiMsg.results = items;
          aiMsg.status = 'done';
          aiMsg.taskId = aiMsg.taskId || '';
          if (aiMsg.taskId) HH.tasks.remove(aiMsg.taskId);

          // 原图 + 缩略图都落盘，history / 会话里只记文件名。
          // （以前按体积判断，超过 900KB 就把 full 换成缩略图，导致预览/下载只有 360px）
          return Promise.all(items.map(function (it) {
            return Promise.all([
              HH.ps.persistImage(it.id, it.dataUrl),
              HH.ps.saveThumb(it.id, it.thumb)
            ]).then(function (r) {
              var st = r[0] || {};
              if (r[1]) it.thumbFile = r[1];
              if (st.file) it.file = st.file;
              return st;
            });
          })).then(function (stored) {
            items.forEach(function (it, i) {
              S.addHistory(Object.assign({
                id: it.id,
                page: 'edit',
                prompt: it.prompt,
                model: it.model,
                size: it.size,
                px: it.px || '',
                createdAt: it.createdAt,
                thumb: it.thumb,
                thumbFile: it.thumbFile || '',
                srcThumb: refs[0] || '',
                // 归属信息：历史卡片双击时按这两个字段把整轮对话捞回来
                sessionId: sessId,
                msgId: aiMsg.id
              }, stored[i] || {}));
            });

            S.touchSession(sess);
            S.saveSessions();

            if (isMock) UI.toast('未配置 API，已用本地占位图演示流程', 'ok');
            else UI.toast('生成完成，共 ' + items.length + ' 张，已存到资料库 images 目录', 'ok');
          });
        });
      }

      function fail(err) {
        var text = (err && err.message) || '生成失败';

        // 有 taskId 说明任务已经在服务端排队/跑起来了，不是真失败 ——
        // 别让用户重新生成（那会再扣一次钱），告诉他回来点「取回结果」
        if (err && err.taskId) {
          aiMsg.status = 'pending';
          aiMsg.taskId = err.taskId;
          aiMsg.taskStatus = 'unknown';
          aiMsg.error = '面板这边中断了，但任务 ' + String(err.taskId).slice(-6) +
            ' 仍在服务端运行（也可能已经出完图）。回来点这一轮的「取回结果」就能拿回，' +
            '不用重新生成，也不会重复扣费。' +
            (hiddenDuringRun ? '（本次中断是因为面板被收起）' : '');
          return;
        }

        aiMsg.status = 'error';
        // 面板被收起/关闭时，CEP 会冻结页面，正在等待的 fetch 被取消 ——
        // 这跟接口没关系，服务端多半已经出图并扣费了，只是响应送不回来。
        if (hiddenDuringRun && /Failed to fetch|网络请求失败/i.test(text)) {
          text = '生成被中断：面板被收起或关闭时，Adobe 会冻结面板页面，正在等待的请求随之取消。' +
            '建议在「我的」里确认「异步出图」是开启的 —— 开启后出图期间收起面板也不会丢图。';
        }
        aiMsg.error = text;
      }

      function wrapUp() {
        s.running = false;
        hiddenDuringRun = false;
        S.touchSession(sess);
        S.saveSessions();
        renderRunState();
        renderMessages();
        renderSessTag();
        scrollBottom();
      }

      // 异步出图：提交 0.5 秒就返回，之后轮询。期间随便收起面板都不会丢图。
      var useAsync = HH.api.isConfigured() && S.state.api.async !== false && HH.api.generateTask;

      if (useAsync) {
        return HH.api.generateTask(reqOpts, {
          onTaskId: function (id) {
            aiMsg.taskId = id;
            aiMsg.status = 'pending';
            HH.tasks.add({
              taskId: id, page: 'edit', sessionId: sessId, msgId: aiMsg.id,
              model: model, prompt: promptText, size: label, createdAt: Date.now()
            });
            S.touchSession(sess);
            S.saveSessions();
            renderMessages();
            scrollBottom();
          },
          onProgress: function (st, pg) {
            aiMsg.taskStatus = st;
            aiMsg.progress = pg || '';
            if (S.state.route === 'edit') renderMessages();
          }
        }).then(function (res) {
          return finish(res.items, false);
        }).catch(fail).then(wrapUp);
      }

      return HH.api.generate(reqOpts).then(function (res) {
        return finish(res.items, res.mock);
      }).catch(fail).then(wrapUp);
    });
  }

  /* ---------------- 断点续取 ---------------- */

  /** 轮询进度回显（tasks.js 调用） */
  function onTaskProgress(rec, status, progress) {
    var msg = findMsgByRec(rec);
    if (!msg) return;
    msg.taskStatus = status;
    msg.progress = progress || '';
    if (S.state.route === 'edit') renderMessages();
  }

  /** 任务完成：把图塞回原来那一轮对话（tasks.js 调用） */
  function applyTaskResult(rec, items) {
    var msg = findMsgByRec(rec);
    if (!msg || !items || !items.length) return;

    var label = rec.size || '';
    var chain = Promise.resolve([]);

    items.forEach(function (url) {
      chain = chain.then(function (acc) {
        return Promise.all([
          U.thumb(url, 360, 0.72).catch(function () { return url; }),
          U.imageSize(url).catch(function () { return { w: 0, h: 0 }; })
        ]).then(function (t) {
          acc.push({
            id: U.uid('g'),
            dataUrl: url,
            thumb: t[0],
            px: t[1].w ? (t[1].w + '×' + t[1].h) : '',
            size: label,
            prompt: rec.prompt || msg.prompt || '',
            model: rec.model || msg.model || '',
            createdAt: Date.now()
          });
          return acc;
        });
      });
    });

    chain.then(function (list) {
      msg.results = list;
      msg.status = 'done';
      msg.error = '';
      msg.taskStatus = 'completed';

      return Promise.all(list.map(function (it) {
        return Promise.all([
          HH.ps.persistImage(it.id, it.dataUrl),
          HH.ps.saveThumb(it.id, it.thumb)
        ]).then(function (r) {
          var st = r[0] || {};
          if (r[1]) it.thumbFile = r[1];
          if (st.file) it.file = st.file;
          return st;
        });
      })).then(function (stored) {
        list.forEach(function (it, i) {
          S.addHistory(Object.assign({
            id: it.id,
            page: 'edit',
            prompt: it.prompt,
            model: it.model,
            size: it.size,
            px: it.px || '',
            createdAt: it.createdAt,
            thumb: it.thumb,
            thumbFile: it.thumbFile || '',
            sessionId: rec.sessionId,
            msgId: rec.msgId
          }, stored[i] || {}));
        });

        S.touchSession({ id: rec.sessionId });
        S.saveSessions();
        if (S.state.route === 'edit') { renderMessages(); scrollBottom(); }
      });
    });
  }

  function onTaskFail(rec, message) {
    var msg = findMsgByRec(rec);
    if (!msg) return;
    msg.status = 'pending';
    msg.taskId = rec.taskId;
    msg.error = '还没取回：' + message + '。可以点「取回结果」再试一次。';
    if (S.state.route === 'edit') renderMessages();
  }

  /** 按 sessionId + msgId 找到那条消息（断点续取时当前会话可能已经切走） */
  function findMsgByRec(rec) {
    var sess = (S.state.sessions || []).filter(function (x) { return x.id === rec.sessionId; })[0];
    if (!sess) return null;
    return (sess.messages || []).filter(function (m) { return m.id === rec.msgId; })[0] || null;
  }

  /** 复制任务 ID（CEP 里没有 navigator.clipboard，用老办法兜底） */
  function copyTaskId(msg) {
    var id = String((msg && msg.taskId) || '');
    if (!id) { UI.toast('这条消息没有任务 ID', 'error'); return; }
    try {
      var ta = document.createElement('textarea');
      ta.value = id;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      UI.toast('任务 ID 已复制，可在中转站后台查这条记录', 'ok');
    } catch (e) {
      UI.toast('复制失败，任务 ID：' + id, 'warn', 6000);
    }
  }

  /** 消息上的「取回结果」：拿 taskId 查一次 */
  function onFetchTask(msg) {
    if (!msg || !msg.taskId) { UI.toast('这条消息没有任务 ID', 'error'); return; }
    UI.toast('正在查询任务…', 'ok');
    HH.tasks.fetchNow(msg.taskId).then(function (r) {
      if (!r.ok) { UI.toast(r.message || '取回失败', 'error'); return; }
      applyTaskResult({ sessionId: S.state.edit.sessionId, msgId: msg.id, page: 'edit', size: '', prompt: msg.prompt, model: msg.model }, r.items);
      UI.toast(r.message, 'ok');
    });
  }

  /* ---------------- 消息内操作 ---------------- */
  /**
   * 拿「原图」再干活：内存原图 → 磁盘缓存 → 缩略图
   * （历史记录里只存了缩略图和缓存文件名，所以插入/预览/下载都要先解析）
   *
   * 会顺带判断解析出来的是不是缩略图（imageInfo.lowRes），
   * 是的话先弹一条警告，别让用户以为插进去的是高清原图。
   */
  function withFullImage(item, cb) {
    if (!item) { UI.toast('找不到图片数据', 'error'); return; }
    HH.ps.imageInfo(item).then(function (info) {
      if (!info || !info.url) { UI.toast('找不到可用图片，数据可能已丢失', 'error'); return; }

      if (info.lowRes) {
        UI.toast(
          '注意：原图已丢失，当前只有 ' + info.w + '×' + info.h + ' 缩略图' +
          (info.expect ? '（应为 ' + info.expect + '）' : '') + '，放大会模糊',
          'warn', 5000
        );
      }
      cb(info.url, info);
    });
  }

  function onInsert(msg, id) {
    var item = findResultInMsg(msg, id);
    withFullImage(item, function (url, info) {
      UI.toast('正在插入图层…');
      HH.ps.insertImage(url, '改图', 'selection').then(function (r) {
        var t = HH.ps.insertTip(r, info);
        UI.toast(t.text, t.type, 6000);
      }).catch(function (e) {
        UI.toast(e.message, 'error', 5000);
      });
    });
  }

  /* ---------------- 输入区缩略图：看大图 / 插入 ---------------- */
  function findEditImage(id) {
    return (S.state.edit.images || []).filter(function (i) { return i.id === id; })[0];
  }

  /* 缩略图在输入区里的显示名，同时兼作图层名后缀。
     编号和角标对齐（角标是「参考2」，这里就不能叫「参考1」） */
  function imageHint(it) {
    var i = (S.state.edit.images || []).indexOf(it);
    return i <= 0 ? '主图' : '参考' + (i + 1);
  }

  function viewRefImage(it) {
    if (!it) return;
    UI.preview(it.dataUrl, it.name || imageHint(it), { w: it.w, h: it.h }, [
      { label: '插入图层', primary: true, onClick: function () { insertRefImage(it, true); } }
    ]);
  }

  /**
   * 把输入区里的图直接插进 PS。
   * 这里不需要 withFullImage：dataUrl 就是刚读取时的原图（选区导出 / 本地文件），
   * 没有「原图丢失只剩缩略图」的历史包袱。
   */
  function insertRefImage(it, closeAfter) {
    if (!it || !it.dataUrl) { UI.toast('图片数据已丢失，重新读取一次', 'error'); return; }
    if (!HH.ps.available) { UI.toast('插入图层需在 Photoshop 面板中使用', 'error'); return; }

    UI.toast('正在插入图层…');
    HH.ps.insertImage(it.dataUrl, imageHint(it), 'selection').then(function (r) {
      var tip = HH.ps.insertTip(r, { w: it.w, h: it.h });
      UI.toast(tip.text, tip.type, 6000);
      if (closeAfter) UI.closePreview();
    }).catch(function (e) {
      UI.toast(e.message || '插入失败', 'error', 5000);
    });
  }

  function onDownload(msg, id) {
    var item = findResultInMsg(msg, id);
    withFullImage(item, function (url, info) {
      U.download(url, '改图_' + U.safeName(item.prompt, 'result') + '_' + item.id.slice(-4) + '.png');
      if (info && info.lowRes) {
        UI.toast('下载的仍是 ' + info.w + '×' + info.h + ' 缩略图（原图未留存）', 'warn', 5000);
      }
    });
  }

  function onReedit(msg) {
    var s = S.state.edit;
    s.prompt = msg.prompt || '';
    s.model = msg.model || s.model;

    var ta = U.$('#editPrompt');
    if (ta) { ta.value = s.prompt; ta.focus(); }

    loadRefs(msg).then(function (refs) {
      if (refs.length) {
        s.images = refs.map(function (u, i) {
          return { id: U.uid('img'), dataUrl: u, name: '第 ' + (i + 1) + ' 张' };
        }).slice(0, cap());
      }
      renderThumbs();
      renderPromptMeta();
      UI.toast(refs.length ? '已回填描述和参考图，可修改后重新生成' : '已回填描述（这一轮的参考图没存下来）', refs.length ? 'ok' : 'warn');
    });
  }

  function onRegen(msg) {
    var s = S.state.edit;
    s.prompt = msg.prompt || '';
    s.model = msg.model || s.model;

    loadRefs(msg).then(function (refs) {
      if (refs.length) {
        s.images = refs.map(function (u, i) {
          return { id: U.uid('img'), dataUrl: u, name: '第 ' + (i + 1) + ' 张' };
        }).slice(0, cap());
      }
      run();
    });
  }

  /**
   * 新对话 = 开一个新的对话窗口
   * 当前这段对话整体存档（可在「历史记录 → 对话记录」里双击重新打开），页面清空重来
   */
  function newChat() {
    var s = S.state.edit;
    if (s.running) { UI.toast('生成中，请稍候', 'error'); return; }

    var rounds = roundCount();

    function start() {
      S.newSession();          // 会话对象换新，messages 指向新数组
      s.prompt = '';
      s.images = [];
      var ta = U.$('#editPrompt');
      if (ta) ta.value = '';
      renderMessages();
      renderThumbs();
      renderPromptMeta();
      renderSessTag();
      if (ta) ta.focus();
      UI.toast('已开新对话', 'ok');
    }

    if (!rounds) { start(); return; }

    UI.confirm(
      '开始新对话？',
      '当前这段对话（' + rounds + ' 轮）会保存到「历史记录 → 对话记录」，双击记录即可重新打开。'
    ).then(function (ok) { if (ok) start(); });
  }

  /* ---------------- 绑定 ---------------- */
  function bind(root) {
    var s = S.state.edit;

    /* 历史页「重新编辑」跳转过来时，接住意图并回填 */
    var intent = S.takeIntent();
    if (intent && intent.page === 'edit') {
      s.prompt = intent.prompt || '';
      s.model = intent.model || s.model;
      if (intent.images && intent.images.length) {
        s.images = intent.images.slice(0, cap());
      }
      var ta0 = U.$('#editPrompt');
      if (ta0) ta0.value = s.prompt;
      renderThumbs();
      renderPromptMeta();
      if (s.prompt) UI.toast('已回填历史描述，可直接生成', 'ok');
    }

    /* 模型 / 参数 */
    var modelEl = U.$('#editModel');
    if (modelEl) modelEl.addEventListener('change', function () {
      s.model = modelEl.value;
      syncQualitySelect();          // 换模型 -> 质量选项跟着换
    });

    U.$('#editRatio').addEventListener('change', function () { s.ratio = this.value; });
    U.$('#editCount').addEventListener('change', function () { s.count = parseInt(this.value, 10) || 1; });

    /* 质量：只在当前模型认这个字段时才存在，所以先判空 */
    var qEl = U.$('#editQuality');
    if (qEl) qEl.addEventListener('change', function () { s.quality = qEl.value; });

    /* 输入框
       注意：CEF 旧内核对 textarea 的内部横向滚动处理有 bug，
       一旦 scrollLeft 被置到右侧，接下来打的中文预编辑/上屏文字就会画到很远的位置，
       看起来像「字跑到输入框右边」。每次输入都把它按回 0 最省事。 */
    var promptEl = U.$('#editPrompt');

    function syncPrompt() {
      if (promptEl.scrollLeft) promptEl.scrollLeft = 0;
      s.prompt = promptEl.value;
      renderPromptMeta();
    }
    promptEl.addEventListener('input', syncPrompt);
    // 输入法合成结束再兜一次：个别 CEF 版本在 commit 后不再补 input 事件，
    // 中文就会「看着上屏了但计数/落库还是旧的」
    promptEl.addEventListener('compositionend', syncPrompt);
    promptEl.addEventListener('focus', function () { promptEl.scrollLeft = 0; });
    // Ctrl/Cmd + Enter 直接生成
    promptEl.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });

    bindComposerResize();

    /* 上传（点击按钮 / 拖到按钮上 / 全局粘贴） */
    HH.uploader.bind({
      zone: U.$('[data-act="pickFile"]') || U.$('#composer'),
      input: U.$('#editFile'),
      strip: U.$('#editThumbs'),
      /* getter：bind 只跑一次，服务端上限是之后才学到的，写死就学不到了 */
      get max() { return cap(); },
      firstLabel: '主图',
      getImages: function () { return s.images; },
      addImages: function (items) { s.images = s.images.concat(items).slice(0, cap()); },
      setImages: function (list) { s.images = list; },
      removeImage: function (id) {
        s.images = s.images.filter(function (i) { return i.id !== id; });
      },
      onView: function (id) { viewRefImage(findEditImage(id)); },
      onInsert: function (id) { insertRefImage(findEditImage(id)); },
      isActive: function () { return S.state.route === 'edit'; },
      onChange: renderThumbs
    });

    /* 生成 */
    U.$('#editRun').addEventListener('click', run);

    /* 页头 & 输入区按钮 */
    root.addEventListener('click', function (e) {
      var go = e.target.closest('[data-go]');
      if (go) { location.hash = '#/' + go.getAttribute('data-go'); return; }

      var act = e.target.closest('[data-act]');
      if (!act) return;

      var name = act.getAttribute('data-act');
      if (name === 'newChat') { newChat(); return; }
      if (name === 'pickSel') {
        // 按钮内的 svg 被点中时 closest 仍能拿到按钮
        pickSelection(act.tagName === 'BUTTON' ? act : act.closest('button'));
        return;
      }
    });

    /* 消息区操作（事件委托，重绘后依然有效） */
    var body = U.$('#chatBody');
    body.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || !body.contains(btn)) return;

      var msgEl = btn.closest('[data-mid]');
      var msg = msgEl ? findMsg(msgEl.getAttribute('data-mid')) : null;
      if (!msg) return;

      var name = btn.getAttribute('data-act');

      /* 用户消息里的参考图：预览 / 下载 */
      if (name === 'previewSrc' || name === 'downloadSrc') {
        var idx = parseInt(btn.getAttribute('data-idx'), 10) || 0;
        var ref = (msg.images || [])[idx];
        if (!ref) return;
        // 面板重载后内存里的 base64 没了，只有文件名——回磁盘读一次
        (HH.ps && HH.ps.resolveImage ? HH.ps.resolveImage(ref) : Promise.resolve(ref.dataUrl || ''))
          .then(function (url) {
            if (!url) { UI.toast('这张参考图没存下来（旧记录只留了缩略信息）', 'warn'); return; }
            if (name === 'previewSrc') {
              UI.preview(url, '参考图 ' + (idx + 1), { w: ref.w, h: ref.h });
            } else {
              U.download(url, '参考图_' + (idx + 1) + '.' + U.extOf(url));
            }
          });
        return;
      }

      if (name === 'preview') {
        var fig = btn.closest('[data-id]');
        var item = fig ? findResultInMsg(msg, fig.getAttribute('data-id')) : (msg.results || [])[0];
        withFullImage(item, function (url, info) {
          var tip = U.fmtTime(item.createdAt) + ' · ' + (item.model || '');
          if (info && info.lowRes) tip += ' · 仅存缩略图 ' + info.w + '×' + info.h;
          UI.preview(url, tip, info ? { w: info.w, h: info.h } : null);
        });
        return;
      }
      if (name === 'insert') {
        var fi = btn.closest('[data-id]');
        if (fi) onInsert(msg, fi.getAttribute('data-id'));
        return;
      }
      if (name === 'download') {
        var fd = btn.closest('[data-id]');
        if (fd) onDownload(msg, fd.getAttribute('data-id'));
        return;
      }
      if (name === 'reedit') { onReedit(msg); return; }
      if (name === 'regen') { onRegen(msg); return; }
      if (name === 'fetchTask') { onFetchTask(msg); return; }
      if (name === 'copyTask') { copyTaskId(msg); return; }
    });

    renderMessages();
    renderThumbs();
    renderPromptMeta();
    renderRunState();
    scrollBottom();

    /* 图片是 dataURL，解码完成前 scrollHeight 还算不准，补两次定位 */
    requestAnimationFrame(scrollBottom);
    setTimeout(scrollBottom, 120);

    /* 双击历史记录打开对话时，滚到点开的那张图并高亮一下 */
    var focus = S.state.ui.focusResult;
    if (focus) {
      S.state.ui.focusResult = '';
      setTimeout(function () { focusResult(focus); }, 160);
    }
  }

  HH.pages.edit = {
    render: render,
    bind: bind,
    // 供 tasks.js 断点续取回调
    applyTaskResult: applyTaskResult,
    onTaskProgress: onTaskProgress,
    onTaskFail: onTaskFail
  };

})(window);
