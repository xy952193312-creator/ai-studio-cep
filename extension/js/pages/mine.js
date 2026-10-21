/**
 * pages/mine.js — 「我的」页
 *
 * 核心：自定义 API 配置面板（服务地址 / API Key / 模型名称 / 路径 / 测试连接）
 * 原则：只做配置与连通性校验，不内置任何第三方商业接口地址。
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util, S = HH.store, UI = HH.ui;

  HH.pages = HH.pages || {};

  /* ---------------- 任务取回 ---------------- */
  /**
   * 凭任务 ID 把图拉回来：
   *   写进历史 + 原图落盘到资料库 images 目录（用户要的就是「图能落到本地文件夹」）
   * 中转站后台能看到每次调用的任务 ID，粘贴过来就能救回没显示出来的图。
   */
  function fetchTaskById(tid, btn) {
    if (!HH.api.isConfigured()) { UI.toast('还没配置 API', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '查询中…'; }

    function restore() {
      if (btn) { btn.disabled = false; btn.textContent = '取回'; }
    }

    HH.tasks.fetchNow(tid).then(function (r) {
      restore();
      if (!r.ok) { UI.toast(r.message || '取回失败', 'error', 7000); return; }

      var label = r.items.length + ' 张';
      var chain = Promise.resolve([]);

      r.items.forEach(function (url) {
        chain = chain.then(function (acc) {
          return Promise.all([
            U.thumb(url, 360, 0.72).catch(function () { return url; }),
            U.imageSize ? U.imageSize(url).catch(function () { return { w: 0, h: 0 }; }) : Promise.resolve({ w: 0, h: 0 })
          ]).then(function (t) {
            acc.push({
              id: U.uid('g'),
              dataUrl: url,
              thumb: t[0],
              px: t[1].w ? (t[1].w + '×' + t[1].h) : '',
              size: '',
              prompt: '（任务取回 ' + String(tid).slice(-6) + '）',
              model: S.currentModel ? S.currentModel('generate') : '',
              createdAt: Date.now()
            });
            return acc;
          });
        });
      });

      return chain.then(function (items) {
        // 原图 + 缩略图落盘
        return Promise.all(items.map(function (it) {
          return Promise.all([
            HH.ps.persistImage(it.id, it.dataUrl),
            HH.ps.saveThumb(it.id, it.thumb)
          ]).then(function (res) {
            var st = res[0] || {};
            if (res[1]) it.thumbFile = res[1];
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

          HH.tasks.remove(tid);
          UI.toast('已取回 ' + label + '，存到资料库 images 目录；历史记录里也能看到', 'ok', 6000);
          HH.app.refresh();
        });
      });
    }).catch(function (err) {
      restore();
      UI.toast((err && err.message) || '取回失败', 'error');
    });
  }

  /* ---------------- 渲染 ---------------- */

  /**
   * 可折叠区块
   *
   * 关键约束：折叠只能靠 CSS 收起 .section-body，**不能**改成「展开了才渲染」。
   * 这一页的输入框是 bind() 里一次性 wire() 绑定的，如果收起时把 DOM 删掉、
   * 展开时再重建，绑定就没了 —— 表现会是「折叠过的区块，改了配置保存不进去」，
   * 而且只在折叠过之后才复现，很难查。
   *
   * 状态存在 state.ui.mineOpen 里（store 持久化），切页、重启面板都还记着。
   *
   * @param {string} key    MINE_SECTIONS 里的键
   * @param {string} title  区块标题
   * @param {string} sub    标题右侧的小字（可空）
   * @param {string} body   区块内容 HTML
   */
  function sec(key, title, sub, body) {
    var open = !!(S.state.ui.mineOpen && S.state.ui.mineOpen[key]);
    return '<div class="section' + (open ? '' : ' is-collapsed') + '" data-sec="' + U.escapeHTML(key) + '">' +
      '<div class="section-title is-toggle" data-sec-toggle="' + U.escapeHTML(key) + '" ' +
        'title="点击展开/折叠">' +
        /* 箭头和标题要挤在左边：.section-title 是 space-between，
           不包一层的话三个子元素会被摊成「箭头 / 标题居中 / 小字靠右」 */
        '<span class="sec-t">' + (UI.I.caret || '') + U.escapeHTML(title) + '</span>' +
        (sub ? '<span class="sub">' + U.escapeHTML(sub) + '</span>' : '') +
      '</div>' +
      '<div class="section-body">' + body + '</div>' +
    '</div>';
  }

  function render() {
    var c = S.state.api;
    var configured = HH.api.isConfigured();
    var histCount = S.state.history.length;
    var sessCount = S.activeSessions().length;

    var smart = S.state.ui.insertSmart !== false;
    var useAsync = S.state.api.async !== false;
    var pendingTasks = (HH.tasks && HH.tasks.pending) ? HH.tasks.pending() : [];

    var libDir = (HH.lib && HH.lib.dir()) || '';
    var diskMode = !!(HH.lib && HH.lib.usable());
    /* 「已保存」这行以前只按模式写死一句「写入文件夹 / 暂存面板内（未连接 PS）」，
       结果本地暂存装不下时静默丢掉最老的几段，用户下次重启才发现对话少了。
       现在改成按上一次持久化的真实结果说话：丢了几段、写盘失败没有，都得看得见。 */
    var pi = (S.persistInfo && S.persistInfo()) || null;
    var saveText = sessCount + ' 段对话 · ' + (diskMode ? '写入文件夹' : '暂存面板内');
    var saveCls = 'cfg-value';

    if (pi && pi.mode === 'disk' && !pi.ok) {
      saveText = sessCount + ' 段对话 · 写盘失败，记录还在内存里';
      saveCls = 'cfg-value-error';
    } else if (pi && pi.mode === 'local') {
      if (!pi.ok) {
        saveText = pi.saved + ' 段已存 · 保存失败，记录还在内存里';
        saveCls = 'cfg-value-error';
      } else if (pi.dropped > 0) {
        saveText = pi.saved + ' 段已存 · 另有 ' + pi.dropped + ' 段更早的没存下';
        saveCls = 'cfg-value-warn';
      } else {
        saveText = pi.saved + ' 段已存 · 暂存面板内';
      }
    }

    var statText = HH._libStat
      ? (HH._libStat.sessions + ' 个会话 · ' + HH._libStat.images + ' 张图 · ' +
         HH.lib.humanSize(HH._libStat.bytes))
      : '统计中…';

    return '' +
    '<div class="page" id="minePage">' +

      /* 头部 */
      '<div class="profile-card">' +
        '<div class="profile-avatar">AI</div>' +
        '<div class="profile-info">' +
          '<div class="profile-name">本地工作台</div>' +
          '<div class="profile-desc">' +
            (configured
              ? '已接入自定义服务 · ' + U.escapeHTML(HH.api.normalizeBase(c.baseUrl))
              : '未配置 API · 当前为占位演示模式') +
          '</div>' +
        '</div>' +
        '<span class="tag ' + (configured ? 'tag-success' : 'tag-warn') + '">' +
          (configured ? '已配置' : '未配置') + '</span>' +
      '</div>' +

      /* ===== API 配置 ===== */
      sec('api', 'API 服务配置', '保存后立即生效',

        '<div class="field">' +
          '<div class="field-label">API 服务地址 <span class="hint">必填</span></div>' +
          '<input class="input" id="cfgBaseUrl" spellcheck="false" ' +
            'placeholder="https://api.your-domain.com" value="' + U.escapeHTML(c.baseUrl) + '">' +
        '</div>' +

        '<div class="field">' +
          /* 「仅存本机」是句安慰话，说了等于没说 —— 换成实话：明文存本机。
             CEP 没有安全的密钥存储可用，加密/混淆都是安全剧场（同源脚本一读就解），
             所以给的是诚实手段：旁边放一个「清除」，用完一键抹掉。 */
          '<div class="field-label">API Key <span class="hint">明文存本机，用完可清除</span></div>' +
          '<div class="input-row">' +
            '<div class="pwd-wrap">' +
              '<input class="input" id="cfgApiKey" type="password" spellcheck="false" ' +
                'placeholder="sk-..." value="' + U.escapeHTML(c.apiKey) + '">' +
              '<span class="pwd-eye" id="togglePwd">显示</span>' +
            '</div>' +
            '<button class="btn btn-sm" id="cfgClearKey" style="flex:0 0 auto;height:28px" ' +
              'title="只抹掉 Key，服务地址、模型、历史记录都保留">清除</button>' +
          '</div>' +
        '</div>' +

        '<div class="field">' +
          '<div class="field-label">模型名称 <span class="hint">可手填，也可从服务拉取</span></div>' +
          '<div class="input-row">' +
            '<input class="input" id="cfgModel" spellcheck="false" style="flex:1" ' +
              'placeholder="例：flux-1-schnell / sdxl-turbo" value="' + U.escapeHTML(c.model) + '">' +
            '<button class="btn btn-sm" id="cfgPull" style="flex:0 0 auto;height:28px">拉取模型</button>' +
          '</div>' +
          '<div id="modelPicker"></div>' +
        '</div>' +

        '<div class="field">' +
          '<div class="field-label">接口路径 <span class="hint">默认 OpenAI 兼容</span></div>' +
          '<input class="input" id="cfgPath" spellcheck="false" ' +
            'placeholder="/v1/images/generations" value="' + U.escapeHTML(c.path) + '">' +
        '</div>' +

        '<div class="grid-2">' +
          '<div class="field" style="margin-bottom:0">' +
            '<div class="field-label">请求协议</div>' +
            '<select class="select-native" id="cfgProtocol">' +
              '<option value="openai"' + (c.protocol === 'openai' ? ' selected' : '') + '>OpenAI 兼容</option>' +
              '<option value="custom"' + (c.protocol === 'custom' ? ' selected' : '') + '>自定义 JSON</option>' +
            '</select>' +
          '</div>' +
          '<div class="field" style="margin-bottom:0">' +
            '<div class="field-label">超时（秒）</div>' +
            '<input class="input" id="cfgTimeout" type="number" min="10" max="600" ' +
              'value="' + U.escapeHTML(String(c.timeout)) + '">' +
          '</div>' +
        '</div>' +

        '<div style="display:flex;gap:6px;margin-top:10px">' +
          '<button class="btn" id="cfgTest" style="flex:1">测试连接</button>' +
          '<button class="btn btn-primary" id="cfgSave" style="flex:1;height:28px;font-size:12px;border-radius:4px">保存配置</button>' +
        '</div>' +

        /* 这个 id 原来也叫 cfgTest，和上面「测试连接」按钮重名。
           U.$('#cfgTest') 只会拿到按钮，于是测试结果被写进了按钮里，
           把「测试连接」四个字冲掉，按钮变成一坨 HTTP 状态码。
           结果容器必须单独一个 id。 */
        '<div id="cfgTestResult"></div>' +

        UI.dropdown('高级设置',
          '<div class="field">' +
            '<div class="field-label">常用模型列表 <span class="hint">逗号分隔，用于页面下拉</span></div>' +
            '<textarea class="textarea" id="cfgModelList" style="min-height:48px" ' +
              'placeholder="flux-1-schnell, sdxl-turbo, seedream-3.0">' +
              U.escapeHTML(c.modelList) + '</textarea>' +
          '</div>' +
          '<div class="field" style="margin-bottom:0">' +
            '<div class="field-label">额外请求头 <span class="hint">每行一条 Key: Value</span></div>' +
            '<textarea class="textarea" id="cfgHeaders" style="min-height:48px" ' +
              'placeholder="X-Api-Version: 2024-01">' + U.escapeHTML(c.extraHeaders) + '</textarea>' +
          '</div>')) +

      /* ===== 存储位置 ===== */
      sec('storage', '对话存储位置', '本地文件夹，不限条数',

        '<div class="cfg-row">' +
          '<div style="min-width:0">' +
            '<div class="cfg-label">文件夹</div>' +
            '<div class="cfg-value" style="word-break:break-all">' +
              (libDir ? U.escapeHTML(libDir) : '默认（%APPDATA%\\AIStudio\\data）') +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="cfg-row">' +
          '<div>' +
            '<div class="cfg-label">已保存</div>' +
            '<div class="' + saveCls + '" id="libSaved">' + saveText + '</div>' +
          '</div>' +
          '<button class="btn btn-sm" data-act="goSessions">查看</button>' +
        '</div>' +

        '<div class="cfg-row">' +
          '<div>' +
            '<div class="cfg-label">占用空间</div>' +
            '<div class="cfg-value" id="libStat">' + U.escapeHTML(statText) + '</div>' +
          '</div>' +
        '</div>' +

        '<div style="display:flex;gap:6px;margin-top:8px">' +
          '<button class="btn btn-sm" data-act="pickDir" style="flex:1">选择文件夹</button>' +
          '<button class="btn btn-sm" data-act="openDir" style="flex:1">打开文件夹</button>' +
        '</div>' +

        /* 系统对话框弹不出来时的兜底：直接填路径 */
        '<div class="input-row" style="margin-top:6px">' +
          '<input class="input" id="libDirInput" spellcheck="false" style="flex:1" ' +
            'placeholder="也可以直接粘贴文件夹路径，例：D:\\AIStudio\\data" value="' +
            U.escapeHTML(libDir) + '">' +
          '<button class="btn btn-sm" data-act="applyDir" style="flex:0 0 auto">应用</button>' +
        '</div>' +

        (diskMode
          ? '<div class="cfg-note">每段对话一个 JSON，原图与缩略图都在 images/ 里，可以直接用资源管理器打开、备份、拷走。</div>'
          : '<div class="cfg-note">当前不在 Photoshop 面板中，记录暂存在浏览器存储里（最多 ' +
            S.LS_SESS + ' 段）。在 PS 里打开面板后会自动改用文件夹。</div>')) +

      /* ===== 插入图层方式 ===== */
      sec('insert', '插入图层方式', '',

        '<div class="cfg-row">' +
          '<div style="min-width:0">' +
            '<div class="cfg-label">' + (smart ? '智能对象' : '普通图层（栅格化）') + '</div>' +
            '<div class="cfg-value">' + (smart
              ? '保留原始像素，缩放可逆，裁掉的部分用蒙版遮住'
              : '按选区重采样，拿到手可直接画笔涂抹，裁掉即删除') + '</div>' +
          '</div>' +
          '<button class="btn btn-sm' + (smart ? ' btn-primary-sm' : '') +
            '" data-act="toggleSmart">' + (smart ? '已开启' : '已关闭') + '</button>' +
        '</div>' +
        '<div class="cfg-note">' +
          '图比选区大时（缩小）两种方式清晰度一样；差别在能不能反悔 —— 智能对象双击可编辑原始内容、反复缩放不累积损失，但画笔和多数滤镜要先栅格化。' +
          '想生成完直接涂抹，就关掉这项。' +
        '</div>') +

      /* ===== 出图方式：异步可断点续取 ===== */
      sec('deliver', '出图方式', '决定收起面板会不会丢图',

        '<div class="cfg-row">' +
          '<div style="min-width:0">' +
            '<div class="cfg-label">' + (useAsync ? '异步出图（提交后轮询）' : '同步出图（等接口返回）') + '</div>' +
            '<div class="cfg-value">' + (useAsync
              ? '提交 0.5 秒就返回，出图期间可以随便收起面板、关掉重开'
              : '一次请求等 40-60 秒，期间收起面板就会丢图') + '</div>' +
          '</div>' +
          '<button class="btn btn-sm' + (useAsync ? ' btn-primary-sm' : '') +
            '" data-act="toggleAsync">' + (useAsync ? '已开启' : '已关闭') + '</button>' +
        '</div>' +
        '<div class="cfg-note">' +
          '异步模式下，提交后服务端给一个任务 ID，面板每隔几秒问一次结果。' +
          '每个询问只有几百毫秒，被掐断也无所谓 —— 任务在服务端照跑，' +
          '面板重开会自动接着取，图不会再丢。' +
        '</div>') +

      /* ===== 任务取回 ===== */
      sec('fetch', '任务取回', pendingTasks.length + ' 个待取回',

        (pendingTasks.length
          ? pendingTasks.slice(-3).reverse().map(function (t) {
              var when = U.fmtTime ? U.fmtTime(t.createdAt) : '';
              return '<div class="cfg-row">' +
                '<div style="min-width:0">' +
                  '<div class="cfg-label">…' + U.escapeHTML(String(t.taskId).slice(-8)) + '</div>' +
                  '<div class="cfg-value">' +
                    U.escapeHTML(String(t.prompt || '').slice(0, 20) || '（无提示词）') +
                    (when ? ' · ' + U.escapeHTML(when) : '') +
                  '</div>' +
                '</div>' +
                '<button class="btn btn-sm" data-act="fetchTaskById" data-tid="' + U.escapeHTML(t.taskId) + '">取回</button>' +
              '</div>';
            }).join('')
          : '<div class="cfg-note">没有待取回的任务。</div>') +
        '<div class="cfg-row">' +
          '<input class="input" id="taskIdInput" spellcheck="false" style="flex:1" ' +
            'placeholder="粘贴任务 ID（task_ 开头），可从中转站后台抄">' +
          '<button class="btn btn-sm" data-act="fetchTaskById" data-tid="">取回</button>' +
        '</div>' +
        '<div class="cfg-note">' +
          '取回的图片会写进历史记录，并自动存到资料库 images 目录。' +
          '生成完成后由面板自动保存，一般不需要手动取回。' +
        '</div>' +
        '<div class="cfg-row">' +
          '<div>' +
            '<div class="cfg-label">图片文件夹</div>' +
            '<div class="cfg-value">出图自动存到这里，可用资源管理器打开</div>' +
          '</div>' +
          '<button class="btn btn-sm" data-act="openImgDir" style="flex:0 0 auto">打开</button>' +
        '</div>') +

      /* ===== 清理 ===== */
      sec('clean', '清理', '',

        '<div class="cfg-row">' +
          '<div>' +
            '<div class="cfg-label">图片记录</div>' +
            '<div class="cfg-value">' + histCount + ' 条 · 只清列表，不动对话</div>' +
          '</div>' +
          '<button class="btn btn-sm" data-act="clearHist">清理历史</button>' +
        '</div>' +
        '<div class="cfg-row">' +
          '<div>' +
            '<div class="cfg-label">对话记录</div>' +
            '<div class="cfg-value">会删掉文件夹里的会话文件与图片</div>' +
          '</div>' +
          '<button class="btn btn-sm btn-danger" data-act="clearSess">清空对话</button>' +
        '</div>' +
        '<div class="cfg-row">' +
          '<div>' +
            '<div class="cfg-label">全部本地缓存</div>' +
            '<div class="cfg-value">配置 + 图片记录 + 对话记录 + 临时数据</div>' +
          '</div>' +
          '<button class="btn btn-sm btn-danger" data-act="clearAll">清理缓存</button>' +
        '</div>') +

      /* ===== 诊断与日志 ===== */
      sec('diag', '诊断与日志', '排查灰屏 / 异常用',

        '<div class="diag-box" id="diagEnv">读取中…</div>' +
        '<div class="cfg-row">' +
          '<div>' +
            '<div class="cfg-label">日志</div>' +
            '<div class="cfg-value"><span id="diagCount">0</span> 条 · 同时写入磁盘</div>' +
          '</div>' +
          '<div class="diag-acts">' +
            '<button class="btn btn-sm" data-act="diagRefresh">刷新</button>' +
            '<button class="btn btn-sm" data-act="diagCopy">复制</button>' +
            '<button class="btn btn-sm" data-act="diagOpenDir">打开目录</button>' +
            '<button class="btn btn-sm btn-danger" data-act="diagClear">清空</button>' +
          '</div>' +
        '</div>' +
        '<div class="diag-log" id="diagLog"></div>') +

      '<div class="foot-note">' +
        '<span class="foot-ver" id="footVer">AI Studio CEP v' + (HH.VERSION || '1.0.0') + '</span>' +
        '<span class="foot-dot">·</span>' +
        '<span class="ps-state ' + (HH.ps.available ? 'is-on' : 'is-off') + '" id="psState">' +
          '<i class="dot"></i><span id="psStateText">' +
            (HH.ps.available ? 'Photoshop 已连接' : 'Photoshop 未连接') +
          '</span>' +
        '</span>' +
      '</div>' +

    '</div>';
  }

  /* ---------------- 底部：版本 + Photoshop 连接 ---------------- */

  /** 只看「有没有宿主接口」，不显示具体版本号（一行更清爽） */
  function paintPsState() {
    var box = U.$('#psState');
    var txt = U.$('#psStateText');
    if (!box || !txt) return;

    box.className = 'ps-state ' + (HH.ps.available ? 'is-on' : 'is-off');
    txt.textContent = HH.ps.available ? 'Photoshop 已连接' : 'Photoshop 未连接';
  }

  /* ---------------- 诊断与日志 ---------------- */

  /** 最近展示多少条。面板就这么高，全部铺开反而不利于看重点 */
  var DIAG_SHOW = 60;

  /**
   * 重绘诊断区，并保留日志列表的滚动位置。
   * 自动刷新每几秒就来一次，不保位置的话你正看到第 30 行会被弹回顶部。
   */
  function paintDiag(keepScroll) {
    var envBox = U.$('#diagEnv');
    var logBox = U.$('#diagLog');
    var cnt = U.$('#diagCount');

    var top = (keepScroll && logBox) ? logBox.scrollTop : 0;

    if (!HH.diag) {
      if (envBox) envBox.textContent = '诊断模块未加载（js/diag.js 缺失）';
      return;
    }

    if (envBox) {
      envBox.innerHTML = HH.diag.env().map(function (kv) {
        return '<div class="diag-row">' +
          '<span class="diag-k">' + U.escapeHTML(kv[0]) + '</span>' +
          '<span class="diag-v">' + U.escapeHTML(kv[1]) + '</span>' +
        '</div>';
      }).join('');
    }

    var all = HH.diag.entries();
    if (cnt) cnt.textContent = String(all.length);

    if (logBox) {
      var shown = all.slice(-DIAG_SHOW).reverse();   // 最新的在最上面
      logBox.innerHTML = shown.length
        ? shown.map(function (e) {
            return '<div class="diag-line lv-' + U.escapeHTML(e.level) + '">' +
              '<span class="diag-t">' + U.escapeHTML(e.t) + '</span>' +
              '<span class="diag-tag">' + U.escapeHTML(e.tag) + '</span>' +
              '<span class="diag-msg">' + U.escapeHTML(e.msg) + '</span>' +
            '</div>';
          }).join('')
        : '<div class="diag-line">（暂无记录）</div>';
    }

    if (keepScroll && logBox) logBox.scrollTop = top;
  }

  /**
   * 订阅刷盘，让环境区自己补齐。
   *
   * 为什么需要：env() 里「写入方式」「日志目录」「AutoVisible」这几个字段
   * 都要等异步操作完成才有值，而 paintDiag 是在挂载那一刻画的，
   * 那时往往还没落盘，于是只能显示「尚未写入 / 解析中…」，得手动点刷新才对。
   *
   * 两个保护：
   *   1. 节流 —— 刷盘可能每几秒一次，不必每次都重建 DOM；
   *   2. 自清理 —— 页面被切走后 #diagEnv 就不在文档里了，此时注销订阅，
   *      否则闭包会一直挂在 diag.js 的回调数组上（切页是换节点，没有 unbind 钩子）。
   */
  function watchDiagFlush() {
    if (!HH.diag || !HH.diag.onFlush) return;

    var timer = 0;
    var off = HH.diag.onFlush(function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var box = U.$('#diagEnv');
        // 页面已经切走：注销自己，不再空转
        if (!box || !document.body.contains(box)) {
          if (off) { off(); off = null; }
          return;
        }
        paintDiag(true);
      }, 300);
    });
  }

  /** CEP 里 navigator.clipboard 常常不可用，用 textarea + execCommand 兜底 */
  function copyText(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 测试结果 ---------------- */
  function paintTest(result, running) {
    var box = U.$('#cfgTestResult');
    if (!box) return;

    if (running) {
      box.innerHTML = '<div class="test-result"><span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>正在探测服务连通性…</div>';
      return;
    }
    if (!result) { box.innerHTML = ''; return; }

    var cls = result.level === 'ok' ? 'is-ok' : result.level === 'err' ? 'is-err' : '';
    box.innerHTML = '<div class="test-result ' + cls + '">' +
      '<b>' + (result.ok ? '连接可用' : '连接异常') + '</b>' +
      (result.status ? ' · HTTP ' + result.status : '') +
      (result.latency ? ' · ' + result.latency + 'ms' : '') +
      '<br>' + U.escapeHTML(result.message) +
    '</div>';
  }

  /* ---------------- 模型列表 ---------------- */
  function paintModels(result, running) {
    var box = U.$('#modelPicker');
    if (!box) return;

    if (running) {
      box.innerHTML = '<div class="hint-line">' +
        '<span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:6px"></span>' +
        '正在拉取模型列表…</div>';
      return;
    }
    if (!result) { box.innerHTML = ''; return; }

    if (!result.ok) {
      box.innerHTML = '<div class="hint-line is-err">' + U.escapeHTML(result.message) + '</div>';
      return;
    }

    var opts = result.models.map(function (m) {
      return '<option value="' + U.escapeHTML(m.id) + '">' +
        U.escapeHTML(m.id) + (m.image ? '　★ 生图' : '') + '</option>';
    }).join('');

    box.innerHTML =
      '<div class="hint-line is-ok">' + U.escapeHTML(result.message) +
        (result.latency ? ' · ' + result.latency + 'ms' : '') + '</div>' +
      '<select class="select-native" id="modelPick" style="margin-top:4px">' +
        '<option value="">— 点此选择模型（★ 为生图模型） —</option>' + opts +
      '</select>';

    var sel = U.$('#modelPick');
    if (!sel) return;

    sel.addEventListener('change', function () {
      var v = this.value;
      if (!v) return;

      var input = U.$('#cfgModel');
      if (input) input.value = v;

      // 静默落盘：不触发重绘，否则选择器会消失
      S.saveApiSilent({ model: v });
      HH.app.syncBadge();
      UI.toast('已选用 ' + v, 'ok');
    });
  }

  /* ---------------- 绑定 ---------------- */
  function collect() {
    return {
      baseUrl: (U.$('#cfgBaseUrl') || {}).value || '',
      apiKey: (U.$('#cfgApiKey') || {}).value || '',
      model: (U.$('#cfgModel') || {}).value || '',
      path: (U.$('#cfgPath') || {}).value || '/v1/images/generations',
      protocol: (U.$('#cfgProtocol') || {}).value || 'openai',
      timeout: parseInt((U.$('#cfgTimeout') || {}).value, 10) || 120,
      modelList: (U.$('#cfgModelList') || {}).value || '',
      extraHeaders: (U.$('#cfgHeaders') || {}).value || ''
    };
  }

  /** 异步刷新「占用空间」：直接改文本，不整页重绘（否则会打断 API 输入） */
  function refreshLibStat() {
    var box = U.$('#libStat');
    if (!box) return;

    if (!HH.lib || !HH.lib.usable()) {
      box.textContent = '—';
      return;
    }

    HH.lib.stat().then(function (st) {
      HH._libStat = st;
      var el = U.$('#libStat');
      if (el) {
        el.textContent = st.sessions + ' 个会话 · ' + st.images + ' 张图 · ' + HH.lib.humanSize(st.bytes);
      }
    });
  }

  /* ---------------- 文件夹浏览器 ---------------- */

  /**
   * 面板内的文件夹选择器
   *
   * 为什么不用系统对话框（见 library.listDir 注释）：
   *   ExtendScript 的 Folder.selectDialog 会锁死 PS 主线程；
   *   cep.fs.showOpenDialogEx 虽然不锁 PS，但同步阻塞，一旦被窗口挡住看不见，
   *   面板就永远卡在「选择中…」，只能重开面板甚至重启 PS。
   * 这个浏览器全程跑在页面里，不碰任何宿主对话框，最坏只是列表读不出来。
   */
  function openDirBrowser(startPath, onPick) {
    if (!HH.lib || !HH.lib.listDir) { UI.toast('文件系统不可用', 'error'); return; }

    var old = U.$('#dirPickMask');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var cur = startPath || HH.lib.dir() || '';

    var mask = document.createElement('div');
    mask.className = 'dp-mask';
    mask.id = 'dirPickMask';
    mask.innerHTML =
      '<div class="dp-card">' +
        '<div class="dp-head">' +
          '<span class="dp-title">选择存储文件夹</span>' +
          '<span class="dp-close" data-dp="close">✕</span>' +
        '</div>' +
        '<div class="dp-path" id="dpPath"></div>' +
        '<div class="dp-list" id="dpList"></div>' +
        '<div class="dp-actions">' +
          '<button class="btn btn-ghost" data-dp="close">取消</button>' +
          '<button class="btn btn-primary" data-dp="pick">选这个文件夹</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(mask);

    var pathEl = mask.querySelector('#dpPath');
    var listEl = mask.querySelector('#dpList');

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
    }

    function paint(payload) {
      // 盘符根存的是 'C:'，显示成 'C:/' 更像路径
      var shown = /^[a-zA-Z]:$/.test(cur) ? cur + '/' : cur;
      pathEl.textContent = shown;
      pathEl.title = shown;

      if (!payload.ok) {
        listEl.innerHTML = '<div class="dp-msg is-err">' +
          U.escapeHTML(payload.message || '读不到这个文件夹') + '</div>';
        return;
      }

      var html = '';

      if (!HH.lib.isRoot(cur)) {
        html += '<div class="dp-item dp-up" data-dp="up">' +
                  '<span class="dp-ico">↑</span><span class="dp-name">上一级</span>' +
                '</div>';
      }

      (payload.dirs || []).forEach(function (d) {
        html += '<div class="dp-item" data-dp="enter" data-name="' + U.escapeHTML(d) + '">' +
                  '<span class="dp-ico">▸</span>' +
                  '<span class="dp-name">' + U.escapeHTML(d) + '</span>' +
                '</div>';
      });

      if (!html || (!payload.dirs || !payload.dirs.length)) {
        html += '<div class="dp-msg">这里没有子文件夹' +
          (payload.files ? '（有 ' + payload.files + ' 个文件）' : '') + '</div>';
      }

      listEl.innerHTML = html;
    }

    function go(p) {
      listEl.innerHTML = '<div class="dp-msg">读取中…</div>';
      HH.lib.listDir(p).then(function (r) {
        if (r.ok) cur = r.path;
        paint(r);
      });
    }

    mask.addEventListener('click', function (e) {
      var hit = e.target.closest ? e.target.closest('[data-dp]') : null;

      if (!hit) {
        if (e.target === mask) close();      // 点遮罩空白处关闭
        return;
      }

      var dp = hit.getAttribute('data-dp');

      if (dp === 'close') { close(); return; }
      if (dp === 'up') { go(HH.lib.parentOf(cur)); return; }

      if (dp === 'enter') {
        go(HH.lib.joinPath(cur, hit.getAttribute('data-name')));
        return;
      }

      if (dp === 'pick') {
        close();
        if (onPick) onPick(cur);
      }
    });

    go(cur);
  }

  function bind(root) {
    refreshLibStat();
    paintPsState();
    paintDiag();
    watchDiagFlush();

    /* 输入实时写入内存，change（失焦）落盘 —— 避免打字时被重绘打断 */
    function wire(id, key, transform) {
      var el = U.$('#' + id);
      if (!el) return;
      el.addEventListener('input', function () {
        S.state.api[key] = transform ? transform(el.value) : el.value;
      });
      el.addEventListener('change', function () {
        S.state.api[key] = transform ? transform(el.value) : el.value;
        S.saveApi({});
        HH.app.syncBadge();
      });
    }

    wire('cfgBaseUrl', 'baseUrl', function (v) { return v.trim(); });
    wire('cfgApiKey', 'apiKey', function (v) { return v.trim(); });
    wire('cfgModel', 'model', function (v) { return v.trim(); });
    wire('cfgPath', 'path', function (v) { return v.trim() || '/v1/images/generations'; });
    wire('cfgProtocol', 'protocol');
    wire('cfgTimeout', 'timeout', function (v) { return parseInt(v, 10) || 120; });
    wire('cfgModelList', 'modelList');
    wire('cfgHeaders', 'extraHeaders');

    /* 密码显隐 */
    var eye = U.$('#togglePwd');
    if (eye) {
      eye.addEventListener('click', function () {
        var input = U.$('#cfgApiKey');
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.textContent = show ? '隐藏' : '显示';
      });
    }

    /* 拉取模型列表 */
    U.$('#cfgPull').addEventListener('click', function () {
      var btn = this;
      var draft = collect();

      // 用屏幕上当前填的值去拉，不必先保存
      Object.assign(S.state.api, draft);

      if (!draft.baseUrl) { UI.toast('请先填写 API 服务地址', 'error'); return; }
      if (!draft.apiKey) { UI.toast('拉取模型需要 API Key', 'error'); return; }

      btn.disabled = true;
      btn.textContent = '拉取中…';
      paintModels(null, true);

      HH.api.fetchModels(draft).then(function (r) {
        paintModels(r);

        if (!r.ok) { UI.toast('拉取失败：' + r.message, 'error'); return; }

        // 缓存模型列表：两个页面的下拉会直接用上
        S.saveApiSilent({
          modelCache: JSON.stringify(r.models),
          modelCacheAt: Date.now()
        });

        // 主模型为空时，自动选第一个生图模型，省一步手动操作
        if (!S.state.api.model) {
          var first = null;
          for (var i = 0; i < r.models.length; i++) {
            if (r.models[i].image) { first = r.models[i]; break; }
          }
          first = first || r.models[0];
          if (first) {
            S.saveApiSilent({ model: first.id });
            var input = U.$('#cfgModel');
            if (input) input.value = first.id;
          }
        }

        HH.app.syncBadge();
        UI.toast(r.message, 'ok');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '拉取模型';
      });
    });

    /* 测试连接 */
    U.$('#cfgTest').addEventListener('click', function () {
      var btn = this;
      var draft = collect();

      // 先落到内存，保证测试用的就是屏幕上填的值
      Object.assign(S.state.api, draft);

      if (!draft.baseUrl) { UI.toast('请先填写 API 服务地址', 'error'); return; }

      btn.disabled = true;
      btn.textContent = '测试中…';
      paintTest(null, true);

      HH.api.testConnection(draft).then(function (r) {
        paintTest(r);
        if (r.level === 'ok') UI.toast('连接成功', 'ok');
        else if (r.level === 'warn') UI.toast('服务可达，但需检查配置', 'error');
        else UI.toast('连接失败', 'error');
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '测试连接';
      });
    });

    /* 清除已保存的 Key
     *
     * 为什么只给「清除」而不做加密：CEP 没有安全的密钥存储 API（Chromium 里
     * 调不到系统凭据管理器），能做的加密只能是本地混淆 —— 同源脚本一读就解，
     * 纯安全剧场，还容易让人误以为安全、在共用电脑上放松警惕。
     * 所以给诚实的手段：一键把落在盘上的那份抹掉。
     *
     * 只清 Key 一项，服务地址 / 模型 / 历史 / 对话全部保留 ——
     * 误触一下把历史也清了才叫心疼。
     */
    var clrKey = U.$('#cfgClearKey');
    if (clrKey) clrKey.addEventListener('click', function () {
      if (!S.state.api.apiKey) { UI.toast('当前没有保存 Key', 'ok'); return; }
      UI.confirm('清除已保存的 API Key？',
        '只抹掉这一项，服务地址、模型和历史记录都保留。清除后要重新填写才能出图。'
      ).then(function (ok) {
        if (!ok) return;
        var el = U.$('#cfgApiKey');
        if (el) el.value = '';
        S.saveApiSilent({ apiKey: '' });
        HH.app.syncBadge();
        UI.toast('已清除本机保存的 Key', 'ok');
      });
    });

    /* 保存 */
    U.$('#cfgSave').addEventListener('click', function () {
      S.saveApi(collect());
      HH.app.syncBadge();
      UI.toast('配置已保存', 'ok');
      HH.app.refresh();
    });

    /**
     * 切到新目录并把旧数据搬过去
     *
     * 顺序不能反：先把会话读回内存、图片复制到新目录，再切目录重写索引。
     * 反过来做的话，旧目录里的会话就读不到了。
     */
    function switchTo(p) {
      if (!p) return;
      if (p === HH.lib.dir()) {
        UI.toast('跟当前目录一样，没有切换', 'warn', 3000);
        return;
      }

      UI.confirm('切换存储文件夹？',
        '新位置：' + p + '\n\n已有的对话会一起搬过去（图片 + 会话文件）。'
      ).then(function (ok) {
        if (!ok) return;

        return S.loadAllSessions()
          .then(function () { return HH.lib.copyImagesTo(p); })
          .then(function () { return HH.lib.setDir(p); })
          .then(function (good) {
            if (!good) throw new Error('这个文件夹不可写，换一个试试');
            return S.rewriteLibrary();
          })
          .then(function () {
            HH._libStat = null;
            UI.toast('已切换并迁移完成', 'ok');
          })
          .catch(function (e) {
            UI.toast((e && e.message) || '切换失败', 'error', 6000);
          })
          .then(function () { HH.app.refresh(); });
      });
    }

    /* 本地缓存 */
    /* 区块折叠：只切 class + 存偏好，不动 DOM。
       收起后输入框仍在文档里，wire() 绑的事件和 collect() 的读值都照常工作 ——
       这一点很关键，改成「展开了才渲染」的话，折叠过的区块保存会失效。 */
    root.addEventListener('click', function (e) {
      var toggle = e.target.closest('[data-sec-toggle]');
      if (!toggle) return;
      var key = toggle.getAttribute('data-sec-toggle');
      if (!S.state.ui.mineOpen || !(key in S.state.ui.mineOpen)) return;

      var open = !S.state.ui.mineOpen[key];
      S.state.ui.mineOpen[key] = open;
      var box = toggle.closest('.section');
      if (box) box.classList.toggle('is-collapsed', !open);
      S.saveUi();
    });

    root.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var name = act.getAttribute('data-act');

      if (name === 'goSessions') {
        S.state.ui.historyView = 'sessions';
        S.saveUi();
        location.hash = '#/history';
        return;
      }

      /* 切换「插入为智能对象」 */
      if (name === 'toggleSmart') {
        var next = !(S.state.ui.insertSmart !== false);
        S.setInsertSmart(next);
        UI.toast(next ? '已开启：插入为智能对象（可逆）' : '已关闭：插入为普通图层（可直接涂抹）', 'ok');

        // 只改这一行的文字，不整页重绘 —— 否则「API 服务配置」里正在填的内容会被清掉
        var row = act.parentNode;
        var lb = row.querySelector('.cfg-label');
        var vl = row.querySelector('.cfg-value');
        if (lb) lb.textContent = next ? '智能对象' : '普通图层（栅格化）';
        if (vl) {
          vl.textContent = next
            ? '保留原始像素，缩放可逆，裁掉的部分用蒙版遮住'
            : '按选区重采样，拿到手可直接画笔涂抹，裁掉即删除';
        }
        act.textContent = next ? '已开启' : '已关闭';
        act.className = 'btn btn-sm' + (next ? ' btn-primary-sm' : '');
        return;
      }

      /* 切换「异步出图」 */
      if (name === 'toggleAsync') {
        var nextAsync = !(S.state.api.async !== false);
        S.saveApiSilent({ async: nextAsync });   // 静默写：不重绘，免得清掉正在填的表单
        UI.toast(nextAsync
          ? '已开启异步出图：出图期间可以收起面板，回来自动取回'
          : '已关闭：改回一次请求等到底，期间收起面板会丢图', nextAsync ? 'ok' : 'warn', 6000);

        var arow = act.parentNode;
        var alb = arow.querySelector('.cfg-label');
        var avl = arow.querySelector('.cfg-value');
        if (alb) alb.textContent = nextAsync ? '异步出图（提交后轮询）' : '同步出图（等接口返回）';
        if (avl) {
          avl.textContent = nextAsync
            ? '提交 0.5 秒就返回，出图期间可以随便收起面板、关掉重开'
            : '一次请求等 40-60 秒，期间收起面板就会丢图';
        }
        act.textContent = nextAsync ? '已开启' : '已关闭';
        act.className = 'btn btn-sm' + (nextAsync ? ' btn-primary-sm' : '');
        return;
      }

      /* 按任务 ID 取回：可能是列表里的，也可能是手动填的 */
      if (name === 'fetchTaskById') {
        var tid = String(act.getAttribute('data-tid') || '').trim();
        if (!tid) {
          var box = U.$('#taskIdInput');
          tid = box ? String(box.value || '').trim() : '';
        }
        if (!tid) { UI.toast('先填一个任务 ID', 'error'); return; }
        fetchTaskById(tid, act);
        return;
      }

      /* 打开图片目录（出图自动存这里） */
      if (name === 'openImgDir') {
        if (!HH.lib || !HH.lib.dir()) { UI.toast('还没有可打开的文件夹', 'error'); return; }
        HH.lib.openSub('images');
        return;
      }

      /* ===== 诊断与日志 ===== */

      if (name === 'diagRefresh') {
        if (!HH.diag) { UI.toast('诊断模块未加载', 'error'); return; }
        HH.diag.probe();
        paintDiag();
        UI.toast('已刷新', 'ok');
        return;
      }

      if (name === 'diagCopy') {
        if (!HH.diag) { UI.toast('诊断模块未加载', 'error'); return; }
        var okc = copyText(HH.diag.exportText());
        UI.toast(okc ? '已复制诊断信息，可直接粘贴给我' : '复制失败，请手动选中日志文本', okc ? 'ok' : 'error');
        return;
      }

      if (name === 'diagOpenDir') {
        if (!HH.diag) { UI.toast('诊断模块未加载', 'error'); return; }
        var d = HH.diag.dir();
        if (!d) { UI.toast('日志目录还没准备好，稍等几秒再点', 'error'); return; }
        HH.ps.evalScript('__aiOpenFolder("' + d.replace(/\\/g, '/') + '")');
        return;
      }

      if (name === 'diagClear') {
        if (!HH.diag) { UI.toast('诊断模块未加载', 'error'); return; }
        HH.diag.clear();
        HH.diag.info('diag', '日志已手动清空');
        paintDiag();
        UI.toast('已清空', 'ok');
        return;
      }

      /* 选择存储文件夹：开面板内的浏览器，不弹系统对话框 */
      if (name === 'pickDir') {
        if (!HH.lib || !HH.lib.available()) {
          UI.toast('请从 Photoshop 的「窗口 > 扩展功能」打开面板后再设置', 'error');
          return;
        }
        openDirBrowser(HH.lib.dir(), switchTo);
        return;
      }

      /* 手动填路径 */
      if (name === 'applyDir') {
        var inp = U.$('#libDirInput');
        var typed = inp ? inp.value.replace(/\\/g, '/').replace(/\/+$/, '').trim() : '';
        if (!typed) { UI.toast('先填一个文件夹路径', 'error'); return; }

        // 盘符 / UNC / 类 Unix 根路径，三种都放行
        if (!/^[a-zA-Z]:\//.test(typed) && typed.indexOf('/') !== 0) {
          UI.toast('请填完整路径，例：D:\\AIStudio\\data', 'error', 5000);
          return;
        }
        switchTo(typed);
        return;
      }

      if (name === 'openDir') {
        if (!HH.lib || !HH.lib.dir()) { UI.toast('还没有可打开的文件夹', 'error'); return; }
        HH.lib.openDir();
      }

      if (name === 'clearSess') {
        UI.confirm('清空全部对话？',
          '文件夹里的会话文件与图片会一起删除，且不可恢复。当前正在编辑的这一段会保留。'
        ).then(function (ok) {
          if (!ok) return;
          S.clearSessions().then(function () {
            HH._libStat = null;
            UI.toast('对话已清空', 'ok');
            HH.app.refresh();
          });
        });
      }

      if (name === 'clearHist') {
        UI.confirm('清理全部历史？', '共 ' + S.state.history.length + ' 条图片记录将被删除，「对话记录」仍保留。')
          .then(function (ok) {
            if (!ok) return;
            S.clearHistory();
            UI.toast('历史已清理', 'ok');
            HH.app.refresh();
          });
      }

      if (name === 'clearAll') {
        UI.confirm('清理全部本地缓存？', 'API 配置、图片记录、对话记录、临时数据都会被移除，且不可恢复。')
          .then(function (ok) {
            if (!ok) return;
            try {
              localStorage.removeItem('aistudio.api.v1');
              localStorage.removeItem('aistudio.history.v1');
              localStorage.removeItem('aistudio.sessions.v1');
              localStorage.removeItem('aistudio.ui.v1');
            } catch (err) { /* ignore */ }

            // 磁盘上的原图缓存也要一起清，否则缓存目录会一直攒
            S.state.history.forEach(function (e) {
              if (e.file && HH.ps) HH.ps.cacheRemove(e.file);
            });
            if (HH.lib && HH.lib.usable()) HH.lib.clearAll();
            HH._libStat = null;

            S.state.history = [];
            S.state.sessions = [];
            S.state.api = Object.assign({}, S.DEFAULT_API);
            S.state.edit.results = [];
            S.state.edit.messages = [];
            S.state.edit.sessionId = '';
            S.state.generate.results = [];
            S.state.edit.images = [];
            S.state.generate.images = [];
            S.state.edit.prompt = '';
            S.state.generate.prompt = '';
            S.ensureSession();
            UI.toast('缓存已清理', 'ok');
            HH.app.syncBadge();
            HH.app.refresh();
          });
      }
    });
  }

  HH.pages.mine = { render: render, bind: bind };

})(window);
