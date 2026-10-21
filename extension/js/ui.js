/**
 * ui.js — 公共 UI 组件（Toast / 预览 / 确认框 / 结果卡片 / 折叠面板）
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util;

  /* ================= 图标 ================= */
  var I = {
    upload: '<svg viewBox="0 0 24 24"><path d="M12 3l5 5h-3v6h-4V8H7l5-5zM5 18h14v2H5z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4V4zm2 2v9l4-4 3 3 3-4 2 2V6H6zm3 3.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
    empty: '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4V4zm2 2v12h12V6H6zm2 8l2.5-3 2 2.5L15 10l3 4H8z"/></svg>',
    select: '<svg viewBox="0 0 24 24"><path d="M3 3h5v2H5v3H3V3zm13 0h5v5h-2V5h-3V3zM3 16h2v3h3v2H3v-5zm16 0h2v5h-5v-2h3v-3zM8 8h8v8H8V8zm2 2v4h4v-4h-4z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><path d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M11 3h2v9l3.5-3.5 1.4 1.4L12 16l-5.9-6.1 1.4-1.4L11 12V3zM5 19h14v2H5z"/></svg>',
    caret: '<svg class="caret" viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5z"/></svg>'
  };

  /* ================= Toast ================= */
  var toastTimer = null;
  function toast(msg, type, ms) {
    var wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' is-error' : type === 'ok' ? ' is-ok' : type === 'warn' ? ' is-warn' : '');
    el.textContent = msg;
    wrap.appendChild(el);

    var life = ms || (type === 'error' ? 3200 : 2000);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .25s';
      setTimeout(function () { el.remove(); }, 260);
    }, life);
  }

  /* ================= 图片预览 ================= */
  /**
   * 图片预览
   * @param {string} src
   * @param {string} tip 附加说明（时间 / 模型等）
   * @param {object} real {w,h} 原始像素（预览图被压缩时传入，用于显示「原图」尺寸）
   */
  /**
   * 图片大图预览
   * @param {string} src   图片地址（dataURL / file:// / http）
   * @param {string} tip   顶部说明文字
   * @param {object} real  原图像素 { w, h }，用于和实际尺寸作对比
   * @param {Array}  acts  可选操作按钮 [{ label, primary, onClick }]
   *                       比如缩略图预览时给一个「插入图层」，看完直接动作，不用退出来再找
   */
  function preview(src, tip, real, acts) {
    var box = document.getElementById('lightbox');
    var img = document.getElementById('lightboxImg');
    var t = document.getElementById('lightboxTip');
    var actBox = document.getElementById('lightboxActs');
    if (!box || !src) return;

    if (actBox) {
      actBox.innerHTML = '';
      (acts || []).forEach(function (a) {
        var b = document.createElement('button');
        b.className = 'btn btn-sm ' + (a.primary ? 'btn-primary' : 'btn-ghost');
        b.textContent = a.label;
        b.addEventListener('click', function () {
          if (a.onClick) a.onClick();
        });
        actBox.appendChild(b);
      });
    }

    t.textContent = tip || '';

    // 图片加载完后追加真实像素，方便判断该出 1K 还是 2K
    img.onload = function () {
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      var size = w && h ? (w + ' × ' + h + ' px') : '';
      var origin = (real && real.w && real.h) ? ('原图 ' + real.w + ' × ' + real.h + ' px') : '';

      var parts = [];
      if (tip) parts.push(tip);
      // 只有「记录里的原图尺寸」和「实际解码尺寸」不一致时才单独标出来，
      // 否则会出现「原图 800 × 800 px · 800 × 800 px」这种同一串数字说两遍
      if (origin && !(real.w === w && real.h === h)) parts.push(origin);
      if (size) parts.push(size);
      t.textContent = parts.join(' · ');
    };

    img.src = src;
    box.hidden = false;
  }

  function closePreview() {
    var box = document.getElementById('lightbox');
    if (box) box.hidden = true;
  }

  /* ================= 确认框 ================= */
  var confirmResolve = null;
  function confirmBox(title, text) {
    return new Promise(function (resolve) {
      var modal = document.getElementById('confirmModal');
      document.getElementById('confirmTitle').textContent = title || '确认操作';
      document.getElementById('confirmText').textContent = text || '';
      modal.hidden = false;
      confirmResolve = resolve;
    });
  }

  function bindGlobal() {
    document.addEventListener('click', function (e) {
      // 预览遮罩 / 关闭
      if (e.target.closest('[data-close]') || e.target.id === 'lightboxClose') {
        closePreview();
      }
      // 确认框
      var modal = document.getElementById('confirmModal');
      if (modal && !modal.hidden) {
        if (e.target.id === 'confirmCancel' || e.target.closest('[data-close]')) {
          modal.hidden = true;
          if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
        } else if (e.target.id === 'confirmOk') {
          modal.hidden = true;
          if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
        }
      }
      // 折叠面板
      var ddHeader = e.target.closest('.sp-drop-down-header');
      if (ddHeader) ddHeader.parentElement.classList.toggle('is-open');
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closePreview();
        var modal = document.getElementById('confirmModal');
        if (modal && !modal.hidden) {
          modal.hidden = true;
          if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
        }
      }
    });
  }

  /* ================= 结果卡片 ================= */
  /**
   * @param {object} item {id, dataUrl, thumb, prompt, model, size, createdAt, n}
   *   n  本次输入了几张图（0 = 纯文生图）。老记录没有这个字段就不显示副标题 ——
   *      不知道的事不编，宁可空着。
   * @param {object} opt  {kind:'智能改图'|'AI生图', maxHeight:number}
   */
  function resultCard(item, opt) {
    opt = opt || {};
    // 优先用缩略图（小、快），没有就退回原图
    var src = item.thumb || item.thumbFile || item.file || item.dataUrl || item.full || '';
    var kind = opt.kind || 'AI生图';
    var kindCls = kind === '智能改图' ? 'tag-accent' : '';

    // 角标：标出这张到底存没存原图。
    // 老记录被旧代码把 full 换成了 360 缩略图，但 size 字段还写着 1024×1024，
    // 直接显示 size 会误导人以为有原图（插进去其实是糊的），所以这里按
    // 「是否还有原图来源」来决定显示尺寸还是「仅缩略图」。
    var hasFull = !!(item.file || item.dataUrl || item.full);
    var badgeCls = 'media-badge';
    var badge = item.size || '';
    if (!hasFull) {
      badge = '仅缩略图';
      badgeCls += ' is-warn';
    }

    /* 副标题：把「这次到底怎么出的」讲清楚。
     *
     * 模式是隐式的（有图就走 /v1/images/edits，无图走 generations），界面没有开关，
     * 所以结果卡片上得留一处痕迹 —— 传了 3 张就写「3 张输入」，一张没传就写「文生图」。
     * 端点的完整真相在 diag 日志的 submit 行里（A3），这里只给一眼能看懂的版本。 */
    var sub = '';
    if (item.n > 0) sub = item.n + ' 张输入';
    else if (item.n === 0) sub = '文生图';

    return '' +
      '<article class="result-card" data-id="' + U.escapeHTML(item.id) + '">' +
        '<div class="result-head">' +
          '<div class="result-head-left">' +
            '<span class="tag ' + kindCls + '">' + U.escapeHTML(kind) + '</span>' +
            '<span class="result-model" title="' + U.escapeHTML(item.model || '') + '">' +
              U.escapeHTML(item.model || '未指定模型') + '</span>' +
            (sub ? '<span class="result-sub">' + U.escapeHTML(sub) + '</span>' : '') +
          '</div>' +
          '<span class="result-time">' + U.escapeHTML(U.fmtTime(item.createdAt)) + '</span>' +
        '</div>' +
        '<div class="result-media">' +
          '<img ' + U.lazyImg(src) + ' data-act="preview" alt="结果图">' +
          (badge ? '<span class="' + badgeCls + '">' + U.escapeHTML(badge) + '</span>' : '') +
        '</div>' +
        '<div class="result-actions">' +
          '<button class="btn" data-act="insert" title="插入到当前文档新图层">插入图层</button>' +
          '<button class="btn" data-act="preview">预览</button>' +
          '<button class="btn" data-act="download">下载</button>' +
          '<button class="btn" data-act="reedit">重新编辑</button>' +
          '<button class="btn btn-primary-sm" data-act="regen">再次生成</button>' +
        '</div>' +
        (item.prompt ? '<div class="result-prompt" title="' + U.escapeHTML(item.prompt) + '">' +
          U.escapeHTML(item.prompt) + '</div>' : '') +
      '</article>';
  }

  /**
   * 绑定结果卡片按钮
   * @param {HTMLElement} root
   * @param {object} handlers {insert, preview, download, reedit, regen}
   */
  function bindCardActions(root, handlers) {
    if (!root || root.__bound) return;
    root.__bound = true;
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn || !root.contains(btn)) return;
      var card = btn.closest('.result-card');
      if (!card) return;
      var id = card.getAttribute('data-id');
      var act = btn.getAttribute('data-act');
      var fn = handlers[act];
      if (typeof fn === 'function') fn(id, card, e);
    });
  }

  /** 生成中占位 */
  function skeleton(text) {
    return '<div class="result-skeleton"><span class="spinner"></span>' +
      U.escapeHTML(text || '正在生成，请稍候…') + '</div>';
  }

  /** 空状态 */
  function empty(title, desc) {
    return '<div class="empty">' + I.empty +
      '<div class="empty-title">' + U.escapeHTML(title || '暂无内容') + '</div>' +
      (desc ? '<div class="empty-desc">' + U.escapeHTML(desc) + '</div>' : '') +
      '</div>';
  }

  /** 折叠面板 */
  function dropdown(title, bodyHTML, open) {
    return '<div class="sp-drop-down' + (open ? ' is-open' : '') + '">' +
      '<div class="sp-drop-down-header">' +
        '<div class="sp-drop-down-header-title">' + I.caret + U.escapeHTML(title) + '</div>' +
      '</div>' +
      '<div class="sp-drop-down-body">' + bodyHTML + '</div>' +
    '</div>';
  }

  /** 下拉选项 HTML */
  function options(list, selected) {
    if (!list.length) return '<option value="">（未配置）</option>';
    return list.map(function (v) {
      return '<option value="' + U.escapeHTML(v) + '"' +
        (v === selected ? ' selected' : '') + '>' + U.escapeHTML(v) + '</option>';
    }).join('');
  }

  HH.ui = {
    I: I,
    toast: toast,
    preview: preview,
    closePreview: closePreview,
    confirm: confirmBox,
    bindGlobal: bindGlobal,
    resultCard: resultCard,
    bindCardActions: bindCardActions,
    skeleton: skeleton,
    empty: empty,
    dropdown: dropdown,
    options: options
  };

})(window);
