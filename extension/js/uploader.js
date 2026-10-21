/**
 * uploader.js — 图片上传区（点击 / 拖拽 / 粘贴）
 * 由智能改图页与 AI 生图页共用
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util;

  var MAX_MB = 10;
  var ACCEPT = /^image\/(png|jpe?g|webp|bmp)$/i;

  /** 超过这个位移才算「在拖动」，否则视为点击（点缩略图是要看大图，不是要排序） */
  var DRAG_THRESHOLD = 5;

  /**
   * 文件列表 -> 图片项数组
   *
   * 顺序很关键：**先全量校验，再按名额取前 max 个，最后才读文件**。
   *
   * 旧实现是 slice(0, max) 之后才校验 —— 前 max 个里只要混进一个不合法的
   * （格式不支持 / 超过 10MB），名额就被它白占一个，排在后面的好图反而进不来，
   * 而好图排第几完全由文件管理器的排序决定，用户根本控不住。
   * 更要命的是调用方拿「选中的总数」去报「只添加了前 N 张」，数字对不上，
   * 用户会以为后面那几张图坏了。
   *
   * 校验只看 f.type 和 f.size（零 IO），所以全量扫一遍不增加任何读取成本；
   * 真正读文件（readAsDataURL）只发生在最终入选的那几张上，比旧实现还省。
   *
   * @param {ArrayLike} files 文件列表
   * @param {number} [max] 名额上限（不传 = 不限）
   * @param {number} [maxMB] 单文件体积上限（默认 10MB）
   * @returns {Promise<{items:Array, errors:string[], accepted:number, truncated:boolean}>}
   *   accepted   校验通过的总数（截断之前的），提示里要用它当分母
   *   truncated  是否因为名额不够而截断；true 时调用方应当提示
   */
  function toItems(files, max, maxMB) {
    var limit = maxMB || MAX_MB;
    var list = Array.prototype.slice.call(files || []);

    var errs = [];
    var ok = [];
    list.forEach(function (f) {
      var name = f.name || '未命名';
      if (!ACCEPT.test(f.type)) { errs.push('「' + name + '」格式不支持'); return; }
      if (f.size > limit * 1024 * 1024) { errs.push('「' + name + '」超过 ' + limit + 'MB'); return; }
      ok.push(f);
    });

    var accepted = ok.length;                       // 校验通过的总数
    var truncated = !!(max && accepted > max);      // 名额够不够
    var picked = max ? ok.slice(0, max) : ok;       // 只有入选的才读盘

    var tasks = picked.map(function (f) {
      return U.readAsDataURL(f).then(function (dataUrl) {
        // 顺带记录原始像素，预览时可显示「原图 W×H」
        return U.imageSize(dataUrl).then(function (sz) {
          return {
            id: U.uid('img'),
            dataUrl: dataUrl,
            name: f.name || 'image',
            w: sz.w,
            h: sz.h
          };
        });
      });
    });

    return Promise.all(tasks.map(function (p) { return p.catch(function (e) { return { error: e.message }; }); }))
      .then(function (res) {
        var items = [];
        res.forEach(function (r) { if (r.error) errs.push(r.error); else items.push(r); });
        return { items: items, errors: errs, accepted: accepted, truncated: truncated };
      });
  }

  /**
   * @param {Element} strip 容器
   * @param {Array} images 图片数组
   * @param {string} firstLabel 第一张的角标（默认「主图」；图生图场景传「底图」。
   *                            传空字符串 = 一张角标都不显示）
   *
   * 第一张不是「随便排第一张」——实测（见 _img2img_test/FINDINGS.md）：
   * [绿,橙] 出图是左绿右橙，第一张占主位；[橙,绿] 语义冲突时保留的是第一张橙。
   * 所以这个顺序有主次，角标必须把「哪张是底图」讲清楚，拖动后还要立刻重算。
   */
  function renderStrip(strip, images, firstLabel) {
    if (!strip) return;
    if (!images.length) { strip.innerHTML = ''; return; }

    var icoView = (HH.ui && HH.ui.I && HH.ui.I.search) || '';
    var icoIns = (HH.ui && HH.ui.I && HH.ui.I.plus) || '+';
    var head = firstLabel === undefined ? '主图' : firstLabel;

    strip.innerHTML = images.map(function (it, i) {
      // 角标要能一眼看出主次：底图 / 参考2 / 参考3 …
      // 编号用 i+1 而不是 i，让角标序号和「第几张」对得上
      var tag = head ? (i === 0 ? head : '参考' + (i + 1)) : '';
      // 悬浮提示带上文件名和原图尺寸。
      // 两张都叫「图1.png」时，只靠位置和角标根本分不出谁是谁，塞到第 10 张
      // 挤在一起时尤其容易删错 —— 而删错第一张等于换掉底图，整轮出图全废。
      // 只放 title，不占可见版面（界面上不加常驻提示）。
      var tip = '拖动可调整顺序';
      if (it.name) tip += '\n' + it.name;
      if (it.w && it.h) tip += ' · ' + it.w + '×' + it.h;
      return '<div class="thumb-item" data-id="' + it.id + '" title="' + U.escapeHTML(tip) + '">' +
        '<img src="' + it.dataUrl + '" alt="" draggable="false">' +
        '<div class="thumb-acts">' +
          '<span class="thumb-act" data-view="' + it.id + '" title="查看大图">' + icoView + '</span>' +
          '<span class="thumb-act" data-ins="' + it.id + '" title="插入到 Photoshop 当前文档">' + icoIns + '</span>' +
        '</div>' +
        (tag ? '<span class="thumb-tag">' + tag + '</span>' : '') +
        '<span class="thumb-del" data-del="' + it.id + '" title="移除">×</span>' +
      '</div>';
    }).join('');
  }

  /**
   * 按当前 DOM 顺序重写角标
   *
   * 拖动过程中只搬 DOM、不重绘（重绘会丢掉正在拖的那个节点），所以角标得手动刷。
   * 少了这一步，把第 3 张拖到第 1 位后会出现两个「底图」、或者第 1 位挂着「参考3」。
   */
  function renumberTags(strip, firstLabel) {
    if (!strip) return;
    var head = firstLabel === undefined ? '主图' : firstLabel;
    if (!head) return;
    Array.prototype.forEach.call(strip.children, function (el, i) {
      var tag = el.querySelector('.thumb-tag');
      if (tag) tag.textContent = i === 0 ? head : '参考' + (i + 1);
    });
  }

  /**
   * 找出「应该插到哪个兄弟的前面/后面」
   *
   * 缩略图条是 flex-wrap，会换行，所以不能只比 x。
   * 做法：按阅读序找离指针最近的那个兄弟（纵向差加权更大，保证优先认同一行），
   * 再看指针落在它中线左边还是右边决定插前插后。
   *
   * @returns {{node:Element, before:boolean}|null}
   */
  function insertionTarget(strip, el, x, y) {
    var best = null, bestD = Infinity;
    Array.prototype.forEach.call(strip.children, function (k) {
      if (k === el) return;
      var r = k.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var d = Math.abs(y - cy) * 3 + Math.abs(x - cx);
      if (d < bestD) { bestD = d; best = { node: k, before: x < cx }; }
    });
    return best;
  }

  /**
   * 按一组 id 重排图片数组
   *
   * 从 DOM 顺序反推数组，多出来的原样补在末尾 —— 万一 DOM 里少了个节点
   * （正在渲染、或刚被删掉），也不能把那张图弄丢。
   */
  function sortBy(images, ids) {
    var map = {}, i;
    for (i = 0; i < images.length; i++) map[images[i].id] = images[i];

    var next = [];
    for (i = 0; i < ids.length; i++) {
      if (map[ids[i]]) { next.push(map[ids[i]]); delete map[ids[i]]; }
    }
    for (i = 0; i < images.length; i++) {
      if (map[images[i].id]) next.push(images[i]);
    }
    return next;
  }

  /**
   * 绑定上传区
   * @param {object} cfg
   *   zone      拖拽区域元素
   *   input     file input
   *   strip     缩略图容器
   *   getImages () => array
   *   addImages (items) => void
   *   setImages (array) => void  拖动排序后写回（不传就不启用排序）
   *   removeImage (id) => void
   *   max        最大张数
   *   firstLabel 第一张的角标，拖动后重算角标时要用
   *   isActive   () => boolean  当前页是否激活（用于粘贴）
   *   onChange   () => void
   */
  function bind(cfg) {
    var zone = cfg.zone, input = cfg.input, strip = cfg.strip;
    if (!zone || !input) return;

    function handleFiles(files) {
      var remain = cfg.max ? cfg.max - cfg.getImages().length : 0;
      if (cfg.max && remain <= 0) {
        HH.ui.toast('最多 ' + cfg.max + ' 张图片，先删掉几张再添加', 'error');
        return;
      }
      toItems(files, cfg.max ? remain : null).then(function (r) {
        r.errors.forEach(function (msg) { HH.ui.toast(msg, 'error'); });
        if (r.items.length) {
          cfg.addImages(r.items);
          if (cfg.onChange) cfg.onChange();
        }
        // 多选很容易一次选中超过剩余名额。静默截断会让用户以为「那几张坏了」。
        // 分母用 r.accepted（校验合格的）而不是「选中的总数」——
        // 选中里可能有格式不支持 / 超 10MB 的，它们已经各自弹过 error，
        // 再混进这条名额提示只会把数字搅乱，让人不知道到底哪几张没进来。
        if (r.truncated) {
          HH.ui.toast('最多 ' + cfg.max + ' 张，本次只添加了前 ' + r.items.length +
            ' 张（共 ' + r.accepted + ' 张合格）', 'warn', 5000);
        }
      });
    }

    /* 缩略图现在就在上传区「里面」，点击会冒泡到 zone。
       不拦的话，点一下缩略图（本意是看大图 / 删除）会顺带弹出文件选择框 ——
       用户看到的是「我想看图，结果给我弹了个窗口」。 */
    zone.addEventListener('click', function (e) {
      if (e.target.closest('.thumb-strip')) return;
      input.click();
    });

    input.addEventListener('change', function () {
      handleFiles(input.files);
      input.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('is-drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      zone.addEventListener(evt, function (e) {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('is-drag');
      });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });

    if (strip) {
      /* ---- 拖动排序 ----
       *
       * 为什么不用原生 HTML5 拖放（draggable + dragstart）：
       *   1. CEP 里原生 drag 事件会被宿主吞掉，drop 时有时无；
       *   2. 缩略图就在上传区里，原生 drag 会和「拖文件进来上传」抢同一片区域，
       *      分不清用户是在给图排序还是在往里塞新图。
       * 指针事件自己算位移，两种意图能彻底分开：按下点在本页面的缩略图上 = 排序，
       * 从外部拖文件进来 = 上传。
       */
      var drag = null;
      var suppressClick = false;

      strip.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;                       // 只认左键
        var el = e.target.closest('.thumb-item');
        if (!el) return;
        // 删除 / 看大图 / 插入这些小按钮上按下时不要进入排序
        if (e.target.closest('.thumb-del') || e.target.closest('.thumb-act')) return;

        suppressClick = false;
        drag = {
          el: el, id: e.pointerId,
          startX: e.clientX, startY: e.clientY,
          active: false
        };
        // 松手可能在元素外，捕获到 strip 上保证 move / up 都收得到
        try { strip.setPointerCapture(e.pointerId); } catch (err) { /* 老引擎不支持就算了 */ }
      });

      strip.addEventListener('pointermove', function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        var dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;

        // 没过阈值就当什么都没发生，留给 click 去处理「看大图」
        if (!drag.active) {
          if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
          drag.active = true;
          drag.el.classList.add('is-dragging');
        }

        var to = insertionTarget(strip, drag.el, e.clientX, e.clientY);
        if (to && to.node.nextSibling !== drag.el) {
          strip.insertBefore(drag.el, to.before ? to.node : to.node.nextSibling);
          renumberTags(strip, cfg.firstLabel);   // 位置一变，角标立刻跟着变
        }
      });

      function endDrag() {
        if (!drag) return;
        var d = drag;
        drag = null;
        try { strip.releasePointerCapture(d.id); } catch (err) { /* 同上 */ }
        if (!d.active) return;                    // 没真的拖动 -> 是点击，放行

        d.el.classList.remove('is-dragging');
        // 拖完浏览器还会补一个 click，那是「看大图」，得吃掉
        suppressClick = true;

        var ids = [];
        Array.prototype.forEach.call(strip.children, function (k) {
          ids.push(k.getAttribute('data-id'));
        });
        if (cfg.setImages) {
          cfg.setImages(sortBy(cfg.getImages() || [], ids));
          if (cfg.onChange) cfg.onChange();
        }
      }

      strip.addEventListener('pointerup', endDrag);
      strip.addEventListener('pointercancel', endDrag);

      strip.addEventListener('click', function (e) {
        if (suppressClick) { suppressClick = false; return; }

        var del = e.target.closest('[data-del]');
        if (del) {
          cfg.removeImage(del.getAttribute('data-del'));
          if (cfg.onChange) cfg.onChange();
          return;
        }

        var ins = e.target.closest('[data-ins]');
        if (ins) {
          if (cfg.onInsert) cfg.onInsert(ins.getAttribute('data-ins'));
          return;
        }

        // 预览按钮 或 直接点图片本体，都是「看大图」
        var target = e.target.closest('[data-view]') || e.target.closest('.thumb-item');
        if (target && cfg.onView) {
          cfg.onView(target.getAttribute('data-view') || target.getAttribute('data-id'));
        }
      });
    }

    // 粘贴：document 级监听全局只挂一次，绑定时只更新当前页配置。
    // 否则每切一次页面就多一个 listener，Ctrl+V 会粘进两张。
    pasteCfg = cfg;
    if (!pasteBound) {
      document.addEventListener('paste', onPaste);
      pasteBound = true;
    }
  }

  /** 当前页上传配置（由最近一次 bind 指定） */
  var pasteCfg = null;
  var pasteBound = false;

  function onPaste(e) {
    var cfg = pasteCfg;
    if (!cfg) return;
    if (cfg.isActive && !cfg.isActive()) return;

    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;

    e.preventDefault();

    var remain = cfg.max ? cfg.max - cfg.getImages().length : 0;
    if (cfg.max && remain <= 0) {
      HH.ui.toast('最多 ' + cfg.max + ' 张图片，先删掉几张再添加', 'error');
      return;
    }
    toItems(files, cfg.max ? remain : null).then(function (r) {
      r.errors.forEach(function (msg) { HH.ui.toast(msg, 'error'); });
      if (r.items.length) {
        cfg.addImages(r.items);
        if (cfg.onChange) cfg.onChange();
      }
      if (r.truncated) {
        HH.ui.toast('最多 ' + cfg.max + ' 张，本次只添加了前 ' + r.items.length +
          ' 张（共 ' + r.accepted + ' 张合格）', 'warn', 5000);
      }
    });
  }

  /**
   * 读取 PS 选区并追加到列表 —— 「智能改图」与「AI 生图」共用
   *
   * 抽成一份的原因：两边原来各写一遍，文案、上限提示、按钮恢复逻辑迟早会岔开，
   * 用户在两页之间切换就会觉得「时好时坏」。这里只管取图和加进数组，
   * 界面刷新交给 onChange，每个页面自己决定怎么重绘。
   *
   * @param {object} o
   *   btn        按钮节点（会被禁用 + 文案改成「读取中…」，结束后恢复）
   *   getIdle    () => 按钮常态 HTML（带图标，不能用 textContent 覆盖）
   *   getImages  () => 当前图片数组
   *   addImage   (item) => void
   *   max        上限
   *   maxMsg     超出上限时的提示文案（默认「最多 N 张图片」）
   *   onChange   () => void
   * @returns {Promise<boolean>} 是否成功加入
   */
  function pickSelection(o) {
    var btn = o.btn;
    var idle = (o.getIdle && o.getIdle()) || '读取选区';

    if (btn && btn.disabled) return Promise.resolve(false);
    if (!HH.ps.available) {
      HH.ui.toast('读取选区需在 Photoshop 面板中使用', 'error');
      return Promise.resolve(false);
    }

    var list = o.getImages() || [];
    if (o.max && list.length >= o.max) {
      HH.ui.toast(o.maxMsg || ('最多 ' + o.max + ' 张图片'), 'error');
      return Promise.resolve(false);
    }

    function restore() {
      if (!btn) return;
      btn.disabled = false;
      btn.innerHTML = idle;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = '读取中…';
    }

    return HH.ps.readSelection().then(function (r) {
      // 异步期间用户可能自己又拖了图进来，这里再判一次
      var cur = o.getImages() || [];
      if (o.max && cur.length >= o.max) {
        HH.ui.toast(o.maxMsg || ('最多 ' + o.max + ' 张图片'), 'error');
        return false;
      }
      o.addImage({
        id: U.uid('img'),
        dataUrl: r.dataUrl,
        name: r.hasSelection ? '选区 ' + r.size : '整图 ' + r.size,
        w: parseInt(String(r.size).split('x')[0], 10) || 0,
        h: parseInt(String(r.size).split('x')[1], 10) || 0
      });
      if (o.onChange) o.onChange();
      HH.ui.toast(r.hasSelection ? '已读取选区 ' + r.size : '无选区，已读取整张图 ' + r.size, 'ok');
      return true;
    }).catch(function (e) {
      HH.ui.toast(e.message || '读取失败', 'error');
      return false;
    }).then(function (v) { restore(); return v; }, function (e) { restore(); throw e; });
  }

  HH.uploader = {
    toItems: toItems,
    renderStrip: renderStrip,
    renumberTags: renumberTags,
    sortBy: sortBy,
    bind: bind,
    pickSelection: pickSelection,
    MAX_MB: MAX_MB
  };

})(window);
