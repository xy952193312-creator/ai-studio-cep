/**
 * util.js — 通用工具
 * 无外部依赖，纯浏览器 / CEP 环境可用
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util = {};

  /* ---------- 版本 ----------
     唯一来源。「我的」页脚直接读它，别在别处再写死一遍：
     曾经 CSXS/manifest.xml 和页面各写一份 1.0.0，改版本时要改两个地方，
     漏一个就会出现「面板显示 1.1.0、PS 扩展管理器里还是 1.0.0」。 */
  HH.VERSION = '1.2.13';

  /* ---------- 提示词长度上限 ----------
     同理，只留一份。之前「智能改图」写 500、「AI 生图」写 800，
     两页各写各的，于是出现「这页打得下、那页打不下」的怪事。

     这个值纯粹是界面限制，不参与任何校验：真正的约束来自你填的 API，
     一般模型都能吃几千字符。超了的服务端会自己报错，届时按提示再调。 */
  HH.MAX_PROMPT = 2000;

  /* ---------- DOM ---------- */
  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- 基础 ---------- */
  U.uid = function (prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  };

  U.escapeHTML = function (str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  U.pad = function (n) { return n < 10 ? '0' + n : '' + n; };

  /**
   * 轮询退避：连续查询失败 n 次后该等多久再问
   *
   * 前台（api.js 的 generateTask）和后台（tasks.js 的 follow）是两条独立的
   * 轮询链，退避规则必须一致，否则同一个任务「重试几次算数」取决于它走的哪条路。
   *
   * @param {number} failRun 连续失败次数，0 表示上一次是成功的
   * @returns {number} 毫秒
   */
  U.pollBackoff = function (failRun) {
    var steps = [6000, 8000, 12000, 20000, 30000];
    if (!failRun || failRun <= 0) return steps[0];
    return steps[Math.min(failRun, steps.length) - 1];
  };

  /** 2026-10-19 14:24 */
  U.fmtTime = function (ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()) +
      ' ' + U.pad(d.getHours()) + ':' + U.pad(d.getMinutes());
  };

  /** 3 分钟前 / 昨天 / 具体时间 */
  U.fmtAgo = function (ts) {
    var diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 172800e3) return '昨天';
    return U.fmtTime(ts).slice(0, 10);
  };

  U.debounce = function (fn, wait) {
    var t = null;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait || 200);
    };
  };

  /* ---------- 图片 ---------- */
  /** 加载图片为 HTMLImageElement */
  U.loadImg = function (src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片加载失败')); };
      img.src = src;
    });
  };

  /** File -> dataURL */
  U.readAsDataURL = function (file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  };

  /**
   * 等比绘制到画布（contain）
   * @returns {HTMLCanvasElement}
   */
  U.fitCanvas = function (img, w, h, bg) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.fillStyle = bg || '#1f1f1f';
    ctx.fillRect(0, 0, w, h);
    var scale = Math.min(w / img.width, h / img.height);
    var dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c;
  };

  /**
   * 生成压缩缩略图（JPEG，控制 localStorage 体积）
   * @param {string} dataUrl 原图 dataURL
   * @param {number} max 最长边
   * @param {number} quality 0-1
   */
  U.thumb = function (dataUrl, max, quality) {
    return U.loadImg(dataUrl).then(function (img) {
      var box = max || 360;
      var scale = Math.min(1, box / Math.max(img.width, img.height));
      var w = Math.max(1, Math.round(img.width * scale));
      var h = Math.max(1, Math.round(img.height * scale));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', quality == null ? 0.72 : quality);
    });
  };

  /** dataURL 体积（KB） */
  U.sizeKB = function (dataUrl) {
    var i = String(dataUrl).indexOf(',');
    var b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    return Math.round(b64.length * 0.75 / 1024);
  };

  /* ---------- 磁盘图片懒加载 ---------- */

  /**
   * 生成 <img> 的 src 片段（磁盘上的图）。
   *
   * CEP 面板是 file:// 页面，加载其它 file:// 图片会被拦（实测 naturalWidth=0），
   * 所以磁盘图一律用 cep.fs 读成 dataURL 再塞回 DOM。
   * 同一张图只读一次，命中缓存后同步返回，不会闪。
   *
   * @param {string} file 文件名（相对 <dir>/images）
   * @returns {string} 形如 'src="..."' 或 'data-file="..."'
   */
  var lazyCache = {};
  var lazyPending = {};

  U.lazyImg = function (file) {
    if (!file) return 'src=""';
    if (String(file).indexOf('data:') === 0) return 'src="' + file + '"';
    if (lazyCache[file]) return 'src="' + lazyCache[file] + '"';

    if (!lazyPending[file] && HH.ps && HH.ps.cacheLoad) {
      lazyPending[file] = true;

      HH.ps.cacheLoad(file).then(function (d) {
        lazyPending[file] = false;
        if (!d) return;
        lazyCache[file] = d;

        // 等这一帧渲染完再回填，避免在字符串拼接过程中改 DOM
        setTimeout(function () {
          var nodes = document.querySelectorAll('[data-file="' + file + '"]');
          for (var i = 0; i < nodes.length; i++) {
            nodes[i].setAttribute('src', d);
            nodes[i].removeAttribute('data-file');
          }
        }, 0);
      });
    }

    return 'data-file="' + file + '"';
  };

  /** 清掉懒加载缓存（切换存储目录 / 清空对话后调用） */
  U.clearLazyCache = function () {
    lazyCache = {};
    lazyPending = {};
  };

  /* ---------- 下载 ---------- */
  /** 从 dataURL 的 mime 推断真实扩展名（jpeg → jpg） */
  U.extOf = function (dataUrl) {
    var m = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(String(dataUrl || ''));
    if (!m) return 'png';
    var t = m[1].toLowerCase();
    if (t === 'jpeg') return 'jpg';
    if (t === 'svg+xml') return 'svg';
    return t;
  };

  /**
   * 保存图片。
   *
   * CEP 面板里 `<a download>` 不会触发保存（Chromium 的下载管理器在 CEP 中被禁用），
   * 所以宿主内走「系统另存为对话框 + cep.fs.writeFile」，
   * 浏览器预览才退回 <a download>。
   *
   * showSaveDialogEx 的签名（踩过的坑，别改回 4 个参数）：
   *   (title, initialPath, fileTypes[], defaultName, friendlyFilePrefix, prompt, nameFieldLabel)
   * - fileTypes 是「不带点的扩展名数组」，传 ['png','jpg'] 会被拼成 `*.png jpg`；
   * - 第 4 个参数才是预填文件名，传 false 会导致文件名框空着；
   * - friendlyFilePrefix 是 Windows 下拉框里显示的说明文字。
   * 后两个参数只在 macOS 生效。
   *
   * @param {string} dataUrl data:image/...
   * @param {string} filename 建议文件名（含或不含扩展名都可以）
   * @returns {Promise<string>|undefined} 保存路径；用户取消时返回已 resolve 的空
   */
  /**
   * 统一转成 PNG dataURL。
   *
   * 下载要一律存 .png，但接口常常直接返回 jpeg / webp。
   * 把 jpeg 字节直接写成 .png 文件，很多软件（含 PS）会判成「格式与后缀不符」，
   * 所以这里用 canvas 重新编码一次：尺寸、像素都不变，只是容器换成 PNG。
   */
  U.toPng = function (dataUrl) {
    var src = String(dataUrl || '');
    if (/^data:image\/png[;,]/.test(src)) return Promise.resolve(src);

    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/png'));
        } catch (e) {
          resolve(src);   // 转码失败退回原数据，至少文件能存下来
        }
      };
      img.onerror = function () { resolve(src); };
      img.src = src;
    });
  };

  U.download = function (dataUrl, filename) {
    // 去掉用户传进来的旧扩展名，统一挂 .png（内容也会转成 png 后再写）
    var base = String(filename || ('aistudio_' + Date.now()))
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\.[a-z0-9]{2,5}$/i, '');
    var ext = 'png';
    var name = base + '.' + ext;

    return U.toPng(dataUrl).then(function (png) {
      var saved = saveToDisk(png, name, ext);
      if (saved) return saved;

      // 浏览器兜底（没有 CEP 文件接口时）
      var a = document.createElement('a');
      a.href = png;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); }, 100);
      return 'browser';
    });
  };

  /**
   * 写入磁盘：CEP 环境返回 Promise，浏览器环境返回 null（调用方退回 <a download>）。
   *
   * showSaveDialogEx 的签名（踩过的坑，别改回 4 个参数）：
   *   (title, initialPath, fileTypes[], defaultName, friendlyFilePrefix, prompt, nameFieldLabel)
   */
  function saveToDisk(dataUrl, name, ext) {
    var cep = global.cep;
    var fs = cep && cep.fs;
    if (!fs || typeof fs.writeFile !== 'function') return null;

    var path = null;

    // 有另存为对话框就用，用户可自选目录
    if (typeof fs.showSaveDialogEx === 'function') {
      var picked = null;
      try {
        picked = fs.showSaveDialogEx(
          '保存图片',                        // title
          '',                                // initialPath：空 = 记住上次目录
          [ext],                             // fileTypes：不带点
          name,                              // defaultName：预填进文件名框
          '图片文件 (*.' + ext + ')',         // friendlyFilePrefix：类型下拉的说明
          '',                                // prompt（mac）
          ''                                 // nameFieldLabel（mac）
        );
      } catch (e) {
        picked = null;
      }

      if (picked && picked.err === 0 && picked.data) {
        path = String(picked.data);
        // 用户在框里把扩展名删了也补回来
        if (!/\.[a-z0-9]{2,5}$/i.test(path)) path += '.' + ext;
      } else if (picked) {
        // err=0 但没路径 / err≠0，都当作「用户取消」，不要偷偷存到别处
        return Promise.resolve('');
      }
    }

    // 对话框不可用时退到「我的文档」，至少不会「点了没反应」
    if (!path) {
      try { path = csPath() + '/' + name; } catch (e2) { path = null; }
    }
    if (!path) return null;

    var b64 = String(dataUrl);
    var idx = b64.indexOf(',');
    if (idx >= 0) b64 = b64.slice(idx + 1);

    var enc = (cep.encoding && cep.encoding.Base64) || 'Base64';
    var w = fs.writeFile(path, b64, enc);

    if (w && w.err === 0) {
      if (HH.ui) HH.ui.toast('已保存：' + path, 'ok', 5000);
      return Promise.resolve(path);
    }
    if (HH.ui) HH.ui.toast('保存失败（错误码 ' + (w && w.err) + '）', 'error');
    return Promise.reject(new Error('保存失败'));
  }

  /** CEP 的用户数据目录（用于无对话框时兜底保存） */
  function csPath() {
    try {
      var ci = new CSInterface();
      var p = ci.getSystemPath(CSInterface.SystemPath.MY_DOCUMENTS);
      if (p) return String(p).replace(/\\/g, '/');
    } catch (e) { /* 忽略，走下面的兜底 */ }
    return '%USERPROFILE%/Documents';
  }

  /** 读取 dataURL 的真实像素尺寸 */
  U.imageSize = function (dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = function () { resolve({ w: 0, h: 0 }); };
      img.src = dataUrl;
    });
  };

  /* ---------- 文件名安全化 ---------- */
  U.safeName = function (text, fallback) {
    var s = String(text || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24);
    return s || (fallback || 'image');
  };

  /* ---------- 简易哈希（用于 mock 配色） ---------- */
  U.hash = function (str) {
    var h = 0, s = String(str || '');
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h;
  };

})(window);
