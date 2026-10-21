/**
 * pages/generate.js — AI 生图页（文生图 / 图生图）
 *
 * 这一页不设「模式开关」。模式由**有没有图**推出来：
 *   无图 + 提示词 -> 文生图，走 POST /v1/images/generations (JSON)
 *   有图 + 提示词 -> 图生图，走 POST /v1/images/edits       (multipart)
 *
 * 为什么不做开关：开关会和图的状态打架。用户删掉最后一张图、开关还停在
 * 「图生图」，生成时就只能报错或者偷偷降级成文生图 —— 两种都不好解释。
 * 让图本身当开关，界面上永远只有一个真相。
 *
 * 顺序：图片 → 提示词 → 生成设置。图片在最上面，是因为它决定这一页现在是
 * 哪种模式，先看它最符合直觉。
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util, S = HH.store, UI = HH.ui;

  var RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'];
  var COUNTS = [1, 2, 4];
  var STYLES = ['写实摄影', '电商白底', '场景合成', '3D 渲染', '插画', '赛博朋克'];
  var MAX_PROMPT = HH.MAX_PROMPT;   // 与「智能改图」共用一份，不再各写各的
  /* 与「智能改图」保持一致。
     10 这个数不是拍的：实测某中转服务的 /v1/images/edits
     对 1/2/3 张都按张计费（image_tokens 415 / 830 / 1245，严格线性），
     红黄蓝三张也确实融合进了同一张输出（见 _img2img_test/FINDINGS.md）。
     所以上限是「体验上限」不是「接口上限」——再多面板就放不下了。 */
  /* 上限为什么是 9 而不是 10（2026-10-20 实测某中转服务）：
   *   传 10 张时服务端直接 400：{"code":"invalid_reference","message":"参考图最多 9 张"}。
   *   9 张以内都正常，且 image_tokens 严格线性（1→415 / 3→1245 / 6→2490），
   *   画面里的颜色种类也随张数涨（3 张 4 种 → 6 张 7 种），说明第 4 张起也真有效。
   *   详见 _img2img_test/FINDINGS.md。 */
  var MAX_IMAGES = 9;

  /* 写死的 9 只是「没被服务端纠正过」时的默认值。
     api.js 只要抓到过一次 400「参考图最多 N 张」，就会记住 N（HH.api.refLimit()），
     之后一律按 N 收缩 —— 服务端哪天把上限改成 5，用户也不用等我们发版。
     注意只降不升：服务端说的比我们保守时听它的，比我们宽松时仍按面板承载力走。 */
  function cap() {
    var n = (HH.api && HH.api.refLimit) ? HH.api.refLimit() : 0;
    return (n > 0 && n < MAX_IMAGES) ? n : MAX_IMAGES;
  }

  /* 上限被压小之前用户可能已经选满了旧上限那么多张。
     提交前先自己收一次并说清楚，别让 api.js 悄悄截掉几张 ——
     那样用户只会看到「少了几张图」却不知道为什么。返回是否动过手。 */
  function clampImages(s) {
    var n = cap();
    if (!s.images || s.images.length <= n) return false;
    s.images = s.images.slice(0, n);
    return true;
  }

  HH.pages = HH.pages || {};

  /* 生成期间面板被收起过？（CEP 冻结页面会掐断页面里正在等待的请求） */
  var hiddenDuringRun = false;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && S.state.generate && S.state.generate.running) hiddenDuringRun = true;
  });

  function sizeLabel(ratio) {
    return HH.api.ratioToSize(ratio).replace('x', '×');
  }

  function findResult(id) {
    var list = S.state.generate.results;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** 当前是不是图生图 —— 全页唯一判定入口，别在别处再写一遍 images.length */
  function isImg2Img() {
    return (S.state.generate.images || []).length > 0;
  }

  /* ---------------- 质量档位 ----------------
   *
   * 选项不是写死的，取决于当前模型（api.qualityOptions）。
   * 非 gpt-image 系列返回 null —— 这时整行都不渲染，
   * 而不是渲染一个「选了也发不出去」的空下拉。
   */

  /** 生成 <option> 串。首屏与换模型共用，避免两处手写各改各的 */
  function qualityOpts(model) {
    var list = HH.api.qualityOptions(model) || [];
    var cur = HH.api.normalizeQuality(model, S.state.generate.quality);
    return list.map(function (q) {
      return '<option value="' + q + '"' + (q === cur ? ' selected' : '') + '>' +
        (HH.api.QUALITY_LABEL[q] || q) + '</option>';
    }).join('');
  }

  function qualityRow(model) {
    if (!HH.api.qualityOptions(model)) return '';
    return '<div class="field" id="genQualityField">' +
      '<div class="field-label">质量 <span class="hint">越高越慢、越贵</span></div>' +
      '<select class="select-native" id="genQuality">' + qualityOpts(model) + '</select>' +
    '</div>';
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var s = S.state.generate;
    var models = S.modelOptions();
    var model = s.model || S.state.api.model || models[0] || '';

    var modelSelect = models.length
      ? '<select class="select-native" id="genModel">' + UI.options(models, model) + '</select>'
      : '<input class="input" id="genModel" placeholder="未配置模型，请到「我的」填写">';

    return '' +
    '<div class="page" id="genPage">' +

      '<div class="page-head">' +
        '<div>' +
          '<div class="page-title">AI 生图</div>' +
          '<div class="page-sub" id="genModeHint">' + modeHint() + '</div>' +
        '</div>' +
        '<div class="page-head-actions">' +
          '<button class="btn btn-sm btn-ghost" data-go="history">历史</button>' +
        '</div>' +
      '</div>' +

      /* ===== 1. 图片 =====
         放最上面：它是这一页的模式开关（有图=图生图），先看到它才讲得通 */
      '<div class="section">' +
        '<div class="section-title">图片 <span class="sub" id="genImgHint">' + imgHint() + '</span></div>' +
        /* 缩略图就放在高亮框「里面」，不再另起一行挂在框下面 ——
           原来那样框是空的、图在框外，看着像两块不相干的区域。
           有图时图标和文案整块撤掉，框里只留缩略图，不堆字。 */
        '<div class="upload-zone" id="genDrop">' +
          '<div class="zone-lead" id="genDropLead">' +
            UI.I.upload +
            '<div class="upload-zone-main" id="genDropMain">' + dropMainHTML() + '</div>' +
          '</div>' +
          '<div class="thumb-strip" id="genThumbs"></div>' +
        '</div>' +
        '<input type="file" id="genFile" accept="image/*" multiple hidden>' +
        '<div class="row-gap">' +
          '<button class="btn btn-sm" data-act="pickSel" title="读取 Photoshop 当前选区">' +
            UI.I.select + '读取选区</button>' +
          '<button class="btn btn-sm" data-act="pickFile">' + UI.I.upload + '上传本地</button>' +
          '<button class="btn btn-sm btn-ghost" data-act="clearImgs" id="genClearImgs">清空</button>' +
        '</div>' +
      '</div>' +

      /* ===== 2. 提示词 ===== */
      '<div class="section">' +
        '<div class="section-title">提示词 <span class="sub">越具体越好</span></div>' +
        '<div class="prompt-wrap">' +
          '<textarea class="textarea" id="genPrompt" maxlength="' + MAX_PROMPT + '" style="min-height:96px" ' +
            'spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" ' +
            'placeholder="' + U.escapeHTML(promptPlaceholder()) + '">' +
            U.escapeHTML(s.prompt) + '</textarea>' +
          '<div class="prompt-meta">' +
            '<span id="genPromptCount">' + s.prompt.length + '/' + MAX_PROMPT + '</span>' +
            '<span class="lnk" data-act="clearPrompt">清空</span>' +
          '</div>' +
        '</div>' +
        '<div class="chips" style="margin-top:8px" id="genStyles">' +
          STYLES.map(function (name) {
            return '<span class="chip' + (s.style === name ? ' is-active' : '') +
              '" data-style="' + name + '">' + name + '</span>';
          }).join('') +
        '</div>' +
        /* 负向提示词直接挂在提示词下面，不再塞进「高级设置」折叠里。
           它和提示词是一对：一个说要什么，一个说不要什么。
           隔着两个折叠去找，写提示词的人根本想不起来还有这一栏。 */
        '<div class="field" style="margin-top:10px;margin-bottom:0">' +
          '<div class="field-label">负向提示词 <span class="hint">不希望出现的内容，可留空</span></div>' +
          '<textarea class="textarea" id="genNegative" style="min-height:52px" ' +
            'placeholder="例：低质量、模糊、多余手指、文字">' + U.escapeHTML(s.negative) + '</textarea>' +
        '</div>' +
      '</div>' +

      /* ===== 3. 生成设置 =====
         模型/比例/张数/质量全部收进这一块，标题就叫「生成设置」。
         都跟出图参数有关，摊开四行会把页面拉得很长 */
      '<div class="section">' +
        '<div class="section-title">生成设置</div>' +
        '<div class="field">' +
          '<div class="field-label">模型 <span class="hint" data-go="mine">在「我的」中自定义 ›</span></div>' +
          modelSelect +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="field" style="margin-bottom:0">' +
            '<div class="field-label">比例</div>' +
            '<select class="select-native" id="genRatio">' +
              RATIOS.map(function (r) {
                return '<option value="' + r + '"' + (r === s.ratio ? ' selected' : '') + '>' + r + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div class="field" style="margin-bottom:0">' +
            '<div class="field-label">张数</div>' +
            '<select class="select-native" id="genCount">' +
              COUNTS.map(function (n) {
                return '<option value="' + n + '"' + (n === s.count ? ' selected' : '') + '>' + n + ' 张</option>';
              }).join('') +
            '</select>' +
          '</div>' +
        '</div>' +
        /* 质量单独一行：三个 select 挤进 .grid-2 的话，
           面板拉到最小 330px 时每格只剩 ~95px，「超高」都会被截断 */
        qualityRow(model) +
      '</div>' +

      '<div class="generate-bar">' +
        '<button class="btn btn-primary" id="genRun">生成</button>' +
      '</div>' +

      '<div class="section" style="margin-top:8px">' +
        '<div class="section-title">生成结果 <span class="sub" id="genResultCount"></span></div>' +
        '<div class="result-list" id="genResults"></div>' +
      '</div>' +

    '</div>';
  }

  /* ---------------- 随模式变化的文案 ----------------
   * 这些字全部由 isImg2Img() 推导，不另存状态。
   * 换模式时只更新这几处，不整页 remount（否则图片预览、焦点、滚动位置全丢）
   */

  function modeHint() {
    return isImg2Img()
      ? '已选图片，按图生图处理（走 /images/edits）'
      : '未选图片，按文生图处理；放一张图就切换成图生图';
  }

  function imgHint() {
    return isImg2Img() ? '已启用图生图，提示词描述想怎么改' : '可选，放图即切换为图生图';
  }

  function dropMainHTML() {
    return '拖入图片，或点击上传（可选，最多 ' + cap() + ' 张）';
  }

  function promptPlaceholder() {
    return isImg2Img()
      ? '描述希望基于这张图改成什么样…'
      : '描述画面内容、光线与风格…';
  }

  /** 只刷新「跟模式有关的文字」和「生成按钮」，节点不动 */
  function syncMode() {
    var on = isImg2Img();

    var d = U.$('#genDropMain');
    if (d) d.textContent = dropMainHTML();

    // 有图后框里就是缩略图本身，图标和引导文案一起撤掉 —— 再写「继续添加」
    // 就是废话：缩略图已经占满，想加的人看得到下面那排按钮
    var lead = U.$('#genDropLead');
    if (lead) lead.hidden = on;

    var zone2 = U.$('#genDrop');
    if (zone2) zone2.classList.toggle('has-thumbs', on);

    var mh = U.$('#genModeHint');
    if (mh) mh.textContent = modeHint();

    var ih = U.$('#genImgHint');
    if (ih) ih.textContent = imgHint();

    var pr = U.$('#genPrompt');
    if (pr) pr.setAttribute('placeholder', promptPlaceholder());

    // 有图时给上传区加一点强调色，明确「这一页现在是图生图」
    var zone = U.$('#genDrop');
    if (zone) zone.classList.toggle('is-armed', on);

    // 清空按钮没图时没意义
    var clr = U.$('#genClearImgs');
    if (clr) clr.hidden = !on;

    var runBtn = U.$('#genRun');
    if (runBtn && !S.state.generate.running) {
      runBtn.textContent = on ? '生成（图生图）' : '生成';
    }
  }

  /* ---------------- 局部刷新 ---------------- */
  function renderThumbs() {
    var list = S.state.generate.images || [];
    // 第一张叫「底图」：/images/edits 里它就是被改造的那张，语义冲突时也是它胜出。
    // 这个角标必须一直显示 —— 它是「拖动排序」唯一的说明书，
    // 用户看到第 1 位标着底图，才知道把哪张拖到第一位意味着什么。
    HH.uploader.renderStrip(U.$('#genThumbs'), list, '底图');
    // 图片增删都会走到这里 —— 图变了，模式和文案就跟着变
    syncMode();
  }

  /**
   * 换模型后重建质量下拉。
   * 不能整页 remount：那会把参考图和滚动位置一起扔掉，
   * 而用户换模型时正盯着参数区，页面一跳会很突然。
   *
   * 两种情况：
   *   旧模型不认 quality、新模型认  -> 插入这一行
   *   旧模型认、新模型不认          -> 撤掉这一行
   *   都认                          -> 只换 <option>，保留节点与焦点
   */
  function syncQuality(model) {
    var s = S.state.generate;
    var field = U.$('#genQualityField');
    var list = HH.api.qualityOptions(model);

    // 该模型不认 quality：整行撤掉。状态留着，换回 gpt-image 时还能恢复
    if (!list) {
      if (field && field.parentNode) field.parentNode.removeChild(field);
      return;
    }

    var cur = HH.api.normalizeQuality(model, s.quality);
    var opts = qualityOpts(model);

    if (field) {
      field.querySelector('select').innerHTML = opts;      // 只换选项，不换节点
    } else {
      // 参数 section = 模型 select 往上最近的那个 .section
      var sec = U.$('#genModel') && U.$('#genModel').closest('.section');
      if (!sec) return;
      sec.insertAdjacentHTML('beforeend',
        '<div class="field" id="genQualityField">' +
          '<div class="field-label">质量 <span class="hint">越高越慢、越贵</span></div>' +
          '<select class="select-native" id="genQuality">' + opts + '</select>' +
        '</div>');
    }

    // 旧值在新模型里可能不合法（1 → 2.5 合法，2.5 → 1 时 xhigh 就得回落）
    s.quality = cur;
  }

  function renderRunState() {
    var btn = U.$('#genRun');
    if (!btn) return;
    var running = S.state.generate.running;
    btn.disabled = running;
    btn.textContent = running ? '生成中…' : (isImg2Img() ? '生成（图生图）' : '生成');
  }

  function renderResults() {
    var box = U.$('#genResults');
    if (!box) return;
    var s = S.state.generate;
    var html = '';

    if (s.running) {
      var tip = s.taskId
        ? '任务 ' + String(s.taskId).slice(-6) + ' · ' + taskStatusText(s.taskStatus) +
          (s.taskProgress ? ' ' + s.taskProgress : '') + '（这期间可以收起面板）…'
        : '正在生成，预计 40-60 秒（期间别收起面板）…';
      html += UI.skeleton(tip);
    }

    if (s.results.length) {
      html += s.results.map(function (it) {
        return UI.resultCard(it, { kind: 'AI生图' });
      }).join('');
    } else if (!s.running) {
      html += UI.empty('还没有生成结果', '填写提示词后点击「生成」');
    }

    box.innerHTML = html;
    var cnt = U.$('#genResultCount');
    if (cnt) cnt.textContent = s.results.length ? '共 ' + s.results.length + ' 张（本次会话）' : '';
  }

  function taskStatusText(st) {
    if (st === 'in_progress') return '服务端生成中';
    if (st === 'completed') return '已出图，正在取回';
    if (st === 'failed') return '任务失败';
    return '已提交，排队中';
  }

  /* ---------------- 生成 ---------------- */
  function run() {
    var s = S.state.generate;
    if (s.running) return;
    if (!s.prompt.trim()) { UI.toast('请先填写提示词', 'error'); U.$('#genPrompt').focus(); return; }

    if (clampImages(s)) {
      renderThumbs();
      UI.toast('服务端当前最多 ' + cap() + ' 张，已只保留前 ' + cap() + ' 张', 'warn');
    }

    var model = S.currentModel('generate');
    var images = (s.images || []).map(function (i) { return i.dataUrl; });
    var prompt = s.style ? (s.prompt.trim() + '，' + s.style + '风格') : s.prompt.trim();

    s.running = true;
    renderRunState();
    renderResults();

    var label = sizeLabel(s.ratio);
    var reqOpts = {
      // 模式由「有没有图」决定，不由开关决定。
      // 'edit' 在 api.js 里会改走 /v1/images/edits —— 塞进 generations 的 image 字段
      // 会被中转站静默丢弃（四轮对照实测，见 _img2img_test/FINDINGS.md）
      mode: images.length ? 'edit' : 'txt',
      prompt: prompt,
      negative: s.negative.trim(),
      model: model,
      ratio: s.ratio,
      count: s.count,
      quality: s.quality,     // 由 api.js 按模型收敛；不认这字段的模型会被丢弃
      images: images
    };

    /* 图片 -> 结果卡片，同步/异步/断点续取共用 */
    function finish(urls, isMock) {
      return urls.reduce(function (chain, url) {
        return chain.then(function (acc) {
          return Promise.all([
            U.thumb(url, 360, 0.72).catch(function () { return url; }),
            U.thumb(url, 1024, 0.85).catch(function () { return url; })
          ]).then(function (pair) {
            acc.push({
              id: U.uid('g'),
              dataUrl: url,
              thumb: pair[0],
              size: label,
              prompt: prompt,
              model: model,
              /* cap() 在这里才求值：万一这一轮刚学会服务端把上限压到 9，
                 重试时只发了 9 张，副标题也得跟着写 9 张，不能写选了 10 张 */
              n: Math.min(images.length, cap()),   // 结果卡片副标题要用（0 张 = 文生图）
              createdAt: Date.now()
            });
            return acc;
          });
        });
      }, Promise.resolve([])).then(function (items) {
        s.results = items.concat(s.results).slice(0, 12);
        // 原图 + 缩略图落盘，history 只留文件名（否则 1024 图会把 localStorage 撑爆）
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
              page: 'generate',
              prompt: it.prompt,
              model: it.model,
              size: it.size,
              px: it.px || '',
              createdAt: it.createdAt,
              thumb: it.thumb,
              thumbFile: it.thumbFile || '',
              srcThumb: ''
            }, stored[i] || {}));
          });
          if (isMock) UI.toast('未配置 API，已用本地占位图演示流程', 'ok');
          else UI.toast('生成完成，共 ' + items.length + ' 张，已存到资料库 images 目录', 'ok');
        });
      });
    }

    function fail(err) {
      var text = (err && err.message) || '生成失败';

      if (err && err.taskId) {
        // 任务已经在服务端跑起来了，不是真失败
        UI.toast('面板这边中断了，但任务 ' + String(err.taskId).slice(-6) +
          ' 仍在服务端运行。到「我的 → 任务取回」粘贴这个 ID 就能拿回图，不用重新生成。', 'warn', 9000);
        return;
      }
      if (hiddenDuringRun && /Failed to fetch|网络请求失败/i.test(text)) {
        text = '生成被中断：面板被收起或关闭时，Adobe 会冻结面板页面。' +
          '建议在「我的」里确认「异步出图」已开启 —— 开启后收起面板也不会丢图。';
      }
      UI.toast(text, 'error', 9000);
    }

    function wrapUp() {
      s.running = false;
      hiddenDuringRun = false;
      renderRunState();
      renderResults();
    }

    var useAsync = HH.api.isConfigured() && S.state.api.async !== false && HH.api.generateTask;

    if (useAsync) {
      HH.api.generateTask(reqOpts, {
        onTaskId: function (id) {
          HH.tasks.add({
            taskId: id, page: 'generate', sessionId: '', msgId: '',
            model: model, prompt: prompt, size: label,
            n: Math.min(images.length, cap()),   // 带上，续取回来的卡片才知道当初传了几张
            createdAt: Date.now()
          });
          s.taskId = id;
          s.taskStatus = 'queued';
          renderResults();
        },
        onProgress: function (st, pg) {
          s.taskStatus = st;
          s.taskProgress = pg || '';
          if (S.state.route === 'generate') renderResults();
        }
      }).then(function (res) {
        return finish(res.items, false);
      }).catch(fail).then(wrapUp);
      return;
    }

    HH.api.generate(reqOpts).then(function (res) {
      return finish(res.items, res.mock);
    }).catch(fail).then(wrapUp);
  }

  /* ---------------- 断点续取（tasks.js 回调） ---------------- */

  function onTaskProgress(rec, status, progress) {
    var s = S.state.generate;
    s.taskId = rec.taskId;
    s.taskStatus = status;
    s.taskProgress = progress || '';
    if (S.state.route === 'generate') renderResults();
  }

  function applyTaskResult(rec, items) {
    var s = S.state.generate;
    if (!items || !items.length) return;

    var label = rec.size || '';
    var chain = Promise.resolve([]);
    items.forEach(function (url) {
      chain = chain.then(function (acc) {
        return U.thumb(url, 360, 0.72).catch(function () { return url; }).then(function (th) {
          acc.push({
            id: U.uid('g'),
            dataUrl: url,
            thumb: th,
            size: label,
            prompt: rec.prompt || '',
            model: rec.model || '',
            n: rec.n,          // 老任务记录没有这个字段 -> undefined -> 不显示副标题
            createdAt: Date.now()
          });
          return acc;
        });
      });
    });

    chain.then(function (list) {
      s.results = list.concat(s.results).slice(0, 12);
      s.taskId = '';
      s.taskStatus = '';
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
            page: 'generate',
            prompt: it.prompt,
            model: it.model,
            size: it.size,
            px: it.px || '',
            createdAt: it.createdAt,
            thumb: it.thumb,
            thumbFile: it.thumbFile || '',
            srcThumb: ''
          }, stored[i] || {}));
        });
        if (S.state.route === 'generate') renderResults();
      });
    });
  }

  function onTaskFail(rec, message) {
    UI.toast('任务 ' + String(rec.taskId).slice(-6) + ' 取回失败：' + message, 'error', 7000);
  }

  /* ---------------- 卡片操作 ---------------- */
  /**
   * 统一取原图：内存 → 磁盘缓存 → 缩略图
   * 顺带判断是不是缩略图，是的话先警告（否则插进去糊了用户也不知道）
   */
  function withFull(id, cb) {
    var item = findResult(id) || S.findHistory(id);
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
      cb(item, info.url, info);
    });
  }

  function onInsert(id) {
    withFull(id, function (item, src, info) {
      UI.toast('正在插入图层…');
      HH.ps.insertImage(src, '生图', 'selection').then(function (r) {
        var t = HH.ps.insertTip(r, info);
        UI.toast(t.text, t.type, 6000);
      }).catch(function (e) { UI.toast(e.message, 'error', 5000); });
    });
  }

  function onDownload(id) {
    withFull(id, function (item, src, info) {
      U.download(src, '生图_' + U.safeName(item.prompt, 'result') + '_' + item.id.slice(-4) + '.png');
      if (info && info.lowRes) {
        UI.toast('下载的仍是 ' + info.w + '×' + info.h + ' 缩略图（原图未留存）', 'warn', 5000);
      }
    });
  }

  /* ---------------- 读取 PS 选区 ----------------
   *
   * 与「智能改图」页共用 HH.uploader.pickSelection：同图标、同文案、同失败提示。
   * 两边行为不一致的话，用户在页面之间切换会觉得「时好时坏」。
   */
  var PICK_IDLE_HTML = UI.I.select + '读取选区';

  function pickSelection(btn) {
    HH.uploader.pickSelection({
      btn: btn,
      getIdle: function () { return PICK_IDLE_HTML; },
      getImages: function () { return S.state.generate.images || []; },
      addImage: function (it) { S.state.generate.images.push(it); },
      max: cap(),
      maxMsg: '最多 ' + cap() + ' 张图片，先删掉一张再读',
      onChange: renderThumbs
    });
  }

  /* ---------------- 输入区参考图：看大图 / 插入 ---------------- */
  function findRefImage(id) {
    return (S.state.generate.images || []).filter(function (i) { return i.id === id; })[0];
  }

  /* 插入图层时给图层起的名字。和缩略图角标用同一套叫法，
     否则「角标写参考2、插进去叫参考1」会让人怀疑自己看错了 */
  function refHint(it) {
    var i = (S.state.generate.images || []).indexOf(it);
    return i <= 0 ? '底图' : '参考' + (i + 1);
  }

  function viewRefImage(it) {
    if (!it) return;
    UI.preview(it.dataUrl, it.name || refHint(it), { w: it.w, h: it.h }, [
      { label: '插入图层', primary: true, onClick: function () { insertRefImage(it, true); } }
    ]);
  }

  function insertRefImage(it, closeAfter) {
    if (!it || !it.dataUrl) { UI.toast('图片数据已丢失，重新读取一次', 'error'); return; }
    if (!HH.ps.available) { UI.toast('插入图层需在 Photoshop 面板中使用', 'error'); return; }

    UI.toast('正在插入图层…');
    HH.ps.insertImage(it.dataUrl, refHint(it), 'selection').then(function (r) {
      var t = HH.ps.insertTip(r, { w: it.w, h: it.h });
      UI.toast(t.text, t.type, 6000);
      if (closeAfter) UI.closePreview();
    }).catch(function (e) { UI.toast(e.message || '插入失败', 'error', 5000); });
  }

  /* 重新编辑：把生图结果转成「智能改图」任务 */
  function onReedit(id) {
    withFull(id, function (item, img) {
      S.setIntent({
        page: 'edit',
        prompt: item.prompt || '',
        model: item.model || '',
        images: [{ id: U.uid('img'), dataUrl: img, name: 'from_generate' }]
      });
      location.hash = '#/edit';
    });
  }

  function onRegen(id) {
    var item = findResult(id) || S.findHistory(id);
    if (!item) return;
    var s = S.state.generate;
    s.prompt = item.prompt || s.prompt;
    s.model = item.model || s.model;
    var pi = U.$('#genPrompt');
    if (pi) pi.value = s.prompt;
    run();
  }

  /* ---------------- 绑定 ---------------- */
  function bind(root) {
    var s = S.state.generate;
    if (!s.images) s.images = [];

    var modelEl = U.$('#genModel');
    if (modelEl) modelEl.addEventListener('change', function () {
      s.model = modelEl.value;
      syncQuality(s.model);          // 模型变了，可用的质量档位跟着变
    });

    /* 质量：用事件委托，因为整行可能被 syncQuality 撤掉/重建 */
    root.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'genQuality') s.quality = e.target.value;
    });

    U.$('#genRatio').addEventListener('change', function () { s.ratio = this.value; });
    U.$('#genCount').addEventListener('change', function () { s.count = parseInt(this.value, 10) || 1; });

    var promptEl = U.$('#genPrompt');
    var countEl = U.$('#genPromptCount');

    function syncPrompt() {
      if (promptEl.scrollLeft) promptEl.scrollLeft = 0;
      s.prompt = promptEl.value;
      if (countEl) countEl.textContent = promptEl.value.length + '/' + MAX_PROMPT;
    }

    promptEl.addEventListener('input', syncPrompt);
    // 输入法合成结束再兜一次：个别 CEF 版本在 commit 后不再补 input 事件
    promptEl.addEventListener('compositionend', syncPrompt);
    promptEl.addEventListener('focus', function () { promptEl.scrollLeft = 0; });

    var negEl = U.$('#genNegative');
    if (negEl) negEl.addEventListener('input', function () { s.negative = negEl.value; });

    /* 风格 chips */
    var styleBox = U.$('#genStyles');
    styleBox.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-style]');
      if (!chip) return;
      var name = chip.getAttribute('data-style');
      s.style = (s.style === name) ? '' : name;
      U.$$('.chip', styleBox).forEach(function (c) {
        c.classList.toggle('is-active', c.getAttribute('data-style') === s.style);
      });
    });

    root.addEventListener('click', function (e) {
      var lnk = e.target.closest('[data-act="clearPrompt"]');
      if (lnk) {
        s.prompt = '';
        promptEl.value = '';
        var c = U.$('#genPromptCount');
        if (c) c.textContent = '0/' + MAX_PROMPT;
        promptEl.focus();
      }
      var go = e.target.closest('[data-go]');
      if (go) location.hash = '#/' + go.getAttribute('data-go');
    });

    /* 读取 PS 选区 —— 与「智能改图」同名同图标同行为，两边要一致 */
    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-act="pickSel"]')) {
        pickSelection(e.target.closest('[data-act="pickSel"]'));
        return;
      }
      // 「上传本地」直接套用隐藏 input，不再单独开一个上传流程
      if (e.target.closest('[data-act="pickFile"]')) {
        var f = U.$('#genFile');
        if (f) f.click();
        return;
      }
      if (e.target.closest('[data-act="clearImgs"]')) {
        if (!isImg2Img()) return;
        s.images = [];
        renderThumbs();
        UI.toast('已清空图片，切回文生图', 'ok');
      }
    });

    /* 图片（有图 = 图生图） */
    HH.uploader.bind({
      zone: U.$('#genDrop'),
      input: U.$('#genFile'),
      strip: U.$('#genThumbs'),
      /* 用 getter 而不是写死一个数字：bind 只跑一次，
         而服务端上限是「跑起来之后才可能学到」的 —— 写死就永远学不到了 */
      get max() { return cap(); },
      firstLabel: '底图',
      getImages: function () { return s.images; },
      addImages: function (items) { s.images = s.images.concat(items).slice(0, cap()); },
      setImages: function (list) { s.images = list; },
      removeImage: function (id) { s.images = s.images.filter(function (i) { return i.id !== id; }); },
      onView: function (id) { viewRefImage(findRefImage(id)); },
      onInsert: function (id) { insertRefImage(findRefImage(id)); },
      isActive: function () { return S.state.route === 'generate'; },
      onChange: renderThumbs
    });

    U.$('#genRun').addEventListener('click', run);

    renderResults();
    UI.bindCardActions(U.$('#genResults'), {
      insert: onInsert,
      preview: function (id) {
        var item = findResult(id) || S.findHistory(id);
        if (item) UI.preview(item.dataUrl || item.full || item.thumb, U.fmtTime(item.createdAt) + ' · ' + (item.model || ''));
      },
      download: onDownload,
      reedit: onReedit,
      regen: onRegen
    });

    renderThumbs();
    renderRunState();
    // 初始对齐一次：热更新进来时状态里可能是旧值（如 xhigh 挂在 gpt-image-1 上）
    syncQuality(S.currentModel('generate'));
    syncMode();
  }

  HH.pages.generate = {
    render: render,
    bind: bind,
    applyTaskResult: applyTaskResult,
    onTaskProgress: onTaskProgress,
    onTaskFail: onTaskFail
  };

})(window);
