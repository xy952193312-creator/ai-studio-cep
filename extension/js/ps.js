/**
 * ps.js — CEP <-> Photoshop 桥
 *
 * 只在 CEP 环境（window.__adobe_cep__）下生效；
 * 浏览器直接打开 index.html 时自动降级为「不支持」并给出提示，不影响 UI 演示。
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};

  /** CEP 运行时注入的宿主对象；浏览器里为 null */
  function host() {
    return global.__adobe_cep__ || null;
  }

  var hasCEP = (function () {
    var h = host();
    return !!(h && typeof h.evalScript === 'function');
  })();

  /** CEP 内置文件系统 API（window.cep.fs），与 Node 是否启用无关 */
  function fsApi() {
    var c = global.cep;
    return (c && c.fs) ? c.fs : null;
  }

  /**
   * 取宿主接口。优先用 CSInterface（可能是官方版或 js/CSInterface.js 垫片）；
   * 万一两者都不可用，直接用 __adobe_cep__ 兜底，避免整块功能瘫痪。
   */
  function cs() {
    if (!hasCEP) return null;
    if (HH._cs !== undefined) return HH._cs;

    try {
      if (typeof CSInterface === 'function') HH._cs = new CSInterface();
    } catch (e) {
      console.warn('[ps] CSInterface 实例化失败，改用底层接口', e);
    }

    if (!HH._cs) {
      HH._cs = {
        evalScript: function (script, cb) {
          host().evalScript(String(script), cb);
        }
      };
    }
    return HH._cs;
  }

  /** 执行宿主 ExtendScript */
  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      var c = cs();
      if (!c) return reject(new Error('未检测到 Photoshop 宿主接口，请从「窗口 > 扩展功能 > AI Studio」打开面板'));
      try {
        c.evalScript(script, function (result) {
          var r = String(result == null ? '' : result);
          if (r.indexOf('ERR:') === 0) reject(new Error(r.slice(4)));
          else resolve(r);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ---------- 临时文件写入（dataURL -> 本地 png） ---------- */

  /**
   * 临时目录。
   *
   * 注意：本机 CEP 12 的 window.cep.fs **没有 getTempDirectory**（只有
   * readFile/writeFile/deleteFile/stat/makedir/showSaveDialogEx 等），
   * 所以目录一律问 ExtendScript 要 Folder.temp，拿到后缓存。
   */
  function tempDir() {
    if (HH._tempDir) return Promise.resolve(HH._tempDir);
    return evalScript('Folder.temp.fsName').then(function (p) {
      var d = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (!d) throw new Error('无法获取临时目录');
      HH._tempDir = d;
      return d;
    });
  }

  function writeTempFile(dataUrl, dir) {
    var idx = String(dataUrl).indexOf(',');
    var base64 = idx >= 0 ? String(dataUrl).slice(idx + 1) : String(dataUrl);
    var name = 'aistudio_' + Date.now() + '.png';
    var path = dir + '/' + name;

    // 方案 A：CEP 内置 fs（无需 Node 集成，首选）
    var fs = fsApi();
    if (fs) {
      var w = null;
      try { w = fs.writeFile(path, base64, 'Base64'); } catch (e) { w = null; }
      if (w && w.err === 0) return path;
      console.warn('[ps] cep.fs.writeFile 失败', w);
    } else {
      console.warn('[ps] window.cep.fs 不可用');
    }

    // 方案 B：Node fs（仅当 manifest 启用 --enable-nodejs 时可用）
    try {
      if (typeof require !== 'function') throw new Error('Node 未启用');
      var nfs = require('fs');
      nfs.writeFileSync(path, Buffer.from(base64, 'base64'));
      return path;
    } catch (e2) {
      throw new Error('无法写入临时文件：' + e2.message);
    }
  }

  /** http(s) 图片转 dataURL（接口直接返回 URL 时用） */
  function toDataURL(src) {
    if (/^data:/i.test(src)) return Promise.resolve(src);
    return fetch(src).then(function (r) { return r.blob(); }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(new Error('图片转码失败')); };
        fr.readAsDataURL(blob);
      });
    });
  }

  /**
   * 是否以「智能对象」方式插入（全局默认，可在「我的」里关掉）
   *
   * true 走 __aiInsertSmart：原始像素保留、缩放是变换、裁边用蒙版（可逆）
   * false 走 __aiInsertLayer：重采样到目标尺寸、clear() 硬裁
   */
  var smartInsert = true;

  /**
   * 把图片作为新图层插入当前文档
   *
   * @param {string} src dataURL 或 http URL
   * @param {string} layerHint 图层名前缀（可选）
   * @param {string} mode 'selection'（默认，铺满当前选区并裁掉溢出）| 'canvas'（整张画布内等比放下）
   * @param {boolean} [smart] 显式指定是否用智能对象；不传则用全局设置
   * @returns {Promise<{name, mode, src, size, kind, masked}>}
   */
  function insertImage(src, layerHint, mode, smart) {
    if (!hasCEP) {
      return Promise.reject(new Error('当前为浏览器预览，插入图层需在 Photoshop 面板中运行'));
    }

    var useSmart = (typeof smart === 'boolean') ? smart : smartInsert;
    var fn = useSmart ? '__aiInsertSmart' : '__aiInsertLayer';

    return toDataURL(src)
      .then(function (dataUrl) {
        return tempDir().then(function (dir) {
          return { dataUrl: dataUrl, dir: dir };
        });
      })
      .then(function (o) {
        var path = writeTempFile(o.dataUrl, o.dir);
        var safe = String(path).replace(/\\/g, '/').replace(/"/g, '\\"');
        var hint = String(layerHint || 'AI').replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 12) || 'AI';

        return evalScript(fn + '("' + safe + '","' + hint + '","' + (mode || 'selection') + '")')
          .then(function (r) {
            // 插入完成即删临时文件，避免 Temp 堆积
            try { fsApi().deleteFile(path); } catch (e) { /* 忽略 */ }

            var out = parseInsertResult(String(r));

            // 栅格化路径用的是 selection.clear()，裁掉就是删掉了，不存在「可恢复」。
            // 不以 JSX 返回值为准（老格式没有该字段，默认 true 会误报），这里按调用方式直接定性。
            if (!useSmart) { out.kind = 'raster'; out.masked = false; }

            return out;
          }, function (e) {
            try { fsApi().deleteFile(path); } catch (e2) { /* 忽略 */ }
            throw e;
          });
      });
  }

  /**
   * 解析插入结果，兼容三种历史格式：
   *   老："OK:名|sel|1000x500"
   *   中："OK:名|sel|1024x512|1000x500"
   *   新："OK:名|sel|1024x512|1000x500|smart"    （+ 可选 "|nomask"）
   *
   * 用「按字段特征识别」而不是按下标硬取，这样 JSX 以后再加字段也不会串位：
   *   - 形如 123x456 的依次为 src（源图像素）、size（插入后尺寸）
   *   - smart / raster 记为 kind
   *   - nomask 表示裁边蒙版没加上（此时是硬裁或没裁）
   *
   * @returns {{name:string, mode:string, src:string, size:string, kind:string, masked:boolean}}
   */
  function parseInsertResult(raw) {
    var s = String(raw || '');
    if (s.indexOf('OK:') !== 0) throw new Error(s.replace(/^ERR:\s*/, '') || '插入失败');

    var parts = s.slice(3).split('|');
    var out = {
      name: parts[0] || 'AI',
      mode: parts[1] === 'sel' ? 'selection' : 'canvas',
      src: '',
      size: '',
      kind: '',        // 'smart' | 'raster'
      masked: true     // 裁边是否走的是蒙版（可逆）
    };

    var sizes = [];
    for (var i = 2; i < parts.length; i++) {
      var p = String(parts[i] || '').trim();
      if (/^\d+\s*[x×]\s*\d+$/i.test(p)) sizes.push(p);
      else if (p === 'smart' || p === 'raster') out.kind = p;
      else if (p === 'nomask') out.masked = false;
    }

    if (sizes.length >= 2) { out.src = sizes[0]; out.size = sizes[1]; }
    else if (sizes.length === 1) { out.size = sizes[0]; }

    return out;
  }

  /**
   * 插入结果的提示文案（三个页面共用，放这里避免各写一套）
   *
   * 之前只报「已插入选区：1024x1024」，那是**选区尺寸**，
   * 1024 原图和 360 缩略图插进同一选区提示一模一样，用户根本分不清。
   * 现在把「原图多大 → 放到多大」都讲清楚，放大超过 1.05× 就升级为警告。
   *
   * @param {object} r parseInsertResult 的结果
   * @param {object} [info] imageInfo 的结果（老版本没有 src 时用它兜底）
   * @returns {{text:string, type:string}} type: 'ok' | 'warn'
   */
  function insertTip(r, info) {
    r = r || {};
    var src = r.src || (info && info.w ? info.w + 'x' + info.h : '');
    var tip = (r.mode === 'selection' ? '已插入选区 ' : '已插入图层 ') + (r.size || '');

    if (src) tip += '（原图 ' + src + '）';

    var sp = parseSize(src);
    var dp = parseSize(r.size);
    var enlarged = false;

    if (sp && dp && sp.w > 0) {
      var k = dp.w / sp.w;
      if (k > 1.05) { tip += '，已放大 ' + k.toFixed(1) + '×，会模糊'; enlarged = true; }
      else if (k < 0.95) tip += '，已缩小 ' + (1 / k).toFixed(1) + '×';
    }

    // 智能对象：缩放是变换不是重采样，放大也能靠原始像素救回来
    if (r.kind === 'smart') {
      tip += enlarged ? '（智能对象，原始像素仍在）' : '（智能对象，可双击编辑）';
    }

    if (r.mode === 'selection') {
      tip += r.masked === false
        ? '（铺满选区，溢出部分已裁掉）'
        : '（铺满选区，溢出部分用蒙版遮住，可随时恢复）';
    }

    return { text: tip, type: enlarged ? 'warn' : 'ok' };
  }

  /**
   * "1024x512" -> { w:1024, h:512 }
   * 兼容中文乘号（记录里的 size 字段是 "1024×1024"）和 *
   */
  function parseSize(str) {
    var m = /^(\d+)\s*[x×✕✖*]\s*(\d+)$/i.exec(String(str || '').trim());
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  }

  /**
   * 量一张图的真实像素尺寸
   * @returns {Promise<{w:number,h:number}>} 读不了返回 null
   */
  function measure(url) {
    if (!url) return Promise.resolve(null);
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      img.onload = function () {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        fin(w && h ? { w: w, h: h } : null);
      };
      img.onerror = function () { fin(null); };
      setTimeout(function () { fin(null); }, 8000);
      img.src = url;
    });
  }

  /**
   * 解析一张图并报告「它到底是原图还是缩略图」
   *
   * 为什么需要这个：旧版本为了不撑爆 localStorage（5MB），
   * 把超过 900KB 的原图直接换成了 360px 缩略图再存 —— 于是历史里
   * 那些老记录的 full 字段本身就是 360 缩略图。点「插入图层」会
   * 静默地把糊图放大铺满选区，用户完全看不出来。
   *
   * 判据（任一命中即 lowRes）：
   *   1. 条目记了期望尺寸（如 "1024x1024"），实测比它小 15% 以上；
   *   2. 解析结果就是 thumb 分支拿到的；
   *   3. 最大边 <= 400px（我们生成的缩略图统一 360）。
   *
   * @param {object} item 历史条目 / 会话结果
   * @returns {Promise<{url:string, w:number, h:number, source:string, lowRes:boolean, expect:string}>}
   */
  function imageInfo(item) {
    if (!item) return Promise.resolve(null);

    var thumb = String(item.thumb || '');
    var useThumb = false;

    return resolveImage(item).then(function (url) {
      if (!url) return null;
      useThumb = !!thumb && url === thumb;
      return measure(url).then(function (m) {
        return { url: url, m: m, useThumb: useThumb };
      });
    }).then(function (o) {
      if (!o) return null;
      var m = o.m || { w: 0, h: 0 };
      var expect = String(item.size || item.ratio || '');
      var exp = parseSize(expect);
      var lowRes = false;

      if (o.useThumb) lowRes = true;

      if (exp && m.w && m.h) {
        // 期望 1024、实测 360 → 明显不是原图
        if (m.w < exp.w * 0.85 || m.h < exp.h * 0.85) lowRes = true;
      } else if (m.w && Math.max(m.w, m.h) <= 400) {
        lowRes = true;
      }

      return {
        url: o.url,
        w: m.w,
        h: m.h,
        source: o.useThumb ? 'thumb' : (item.file ? 'disk' : 'memory'),
        lowRes: lowRes,
        expect: exp ? (exp.w + 'x' + exp.h) : ''
      };
    });
  }

  /** 当前文档信息：{ok, name, width, height} */
  function getDocInfo() {
    if (!hasCEP) return Promise.resolve({ ok: false, name: '未连接 Photoshop' });
    return evalScript('__aiGetDocInfo()')
      .then(function (r) {
        var parts = String(r).split('|');
        if (parts[0] === 'NO_DOC') return { ok: false, name: '未打开文档' };
        return { ok: true, name: parts[0], width: parts[1], height: parts[2] };
      })
      .catch(function () { return { ok: false, name: '未连接 Photoshop' }; });
  }

  /**
   * 读取 Photoshop 当前选区作为参考图（无选区则取整张画布）
   * @returns {Promise<{dataUrl:string, size:string, hasSelection:boolean, pos:string}>}
   */
  function readSelection() {
    if (!hasCEP) {
      return Promise.reject(new Error('当前为浏览器预览，读取选区需在 Photoshop 面板中使用'));
    }

    return evalScript('__aiGetSelection()').then(function (raw) {
      var s = String(raw == null ? '' : raw).trim();

      if (s.indexOf('OK:') !== 0) {
        throw new Error(s.replace(/^ERR:\s*/, '') || '读取选区失败');
      }

      var parts = s.slice(3).split('|');
      var path = parts[0];
      var size = parts[1] || '';
      var hasSelection = parts[2] === '1';
      var pos = parts[3] || '';

      var fs = fsApi();
      if (!fs) throw new Error('CEP 文件接口不可用，无法读取临时图片');

      var rd = null;
      try { rd = fs.readFile(path, 'Base64'); } catch (e) { rd = null; }

      if (!rd || rd.err !== 0 || !rd.data) {
        throw new Error('临时文件读取失败：' + path);
      }

      // 读完即删，避免 Temp 目录堆积
      try { fs.deleteFile(path); } catch (e2) { /* 删不掉不影响使用 */ }

      return {
        dataUrl: 'data:image/png;base64,' + rd.data,
        size: size,
        hasSelection: hasSelection,
        pos: pos
      };
    });
  }

  /* ---------- 原图磁盘缓存 ---------- */

  /**
   * 为什么要有这一层：
   * localStorage 只有 5MB，一张 1024 PNG 就 1~3MB，之前为了不炸配额，
   * 代码里把「超过 900KB 的原图」直接换成 360px 缩略图存起来 ——
   * 于是历史里点预览/下载拿到的是缩略图（用户看到的 360×360 就是这么来的）。
   * 现在原图落盘（%APPDATA%/AIStudio/cache/<id>.<ext>），
   * localStorage 只记文件名，预览/下载/插入图层再按需读回来。
   */

  var MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp'
  };

  /**
   * 缓存目录（问 ExtendScript 要 userData，拿到后缓存）
   *
   * 优先用「我的」里设置的资料库目录（<dir>/images），
   * 这样原图和对话记录放在一起，用户能在资源管理器里直接看到；
   * 没设置时才退回 %APPDATA%/AIStudio/cache。
   */
  function cacheDir() {
    if (HH._cacheDir) return Promise.resolve(HH._cacheDir);
    if (!hasCEP) return Promise.resolve('');

    if (HH.lib && HH.lib.available() && HH.lib.imagesDir()) {
      return HH.lib.ensure().then(function (ok) {
        if (!ok) return '';
        HH._cacheDir = HH.lib.imagesDir();
        return HH._cacheDir;
      });
    }

    return evalScript('__aiCacheDir()').then(function (raw) {
      var s = String(raw || '');
      if (s.indexOf('OK:') !== 0) throw new Error(s.replace(/^ERR:\s*/, '') || '缓存目录不可用');
      HH._cacheDir = s.slice(3).replace(/\\/g, '/').replace(/\/+$/, '');
      return HH._cacheDir;
    }, function () {
      return '';
    });
  }

  /** 用户切换资料库目录后调用，让下次写入落到新目录 */
  function resetCacheDir() {
    HH._cacheDir = '';
  }

  /**
   * 把 dataURL 写进缓存目录
   * @param {string} id 记录 id（做文件名，需唯一）
   * @param {string} dataUrl
   * @returns {Promise<string>} 成功返回文件名（如 g_xxx.png），失败返回 ''
   */
  function cacheSave(id, dataUrl) {
    var fs = fsApi();
    if (!fs || !hasCEP) return Promise.resolve('');

    var ext = HH.util.extOf(dataUrl);
    var file = String(id || ('img_' + Date.now())).replace(/[^\w-]/g, '') + '.' + ext;
    var b64 = String(dataUrl);
    var i = b64.indexOf(',');
    if (i >= 0) b64 = b64.slice(i + 1);

    return cacheDir().then(function (dir) {
      if (!dir) return '';
      var w = null;
      try { w = fs.writeFile(dir + '/' + file, b64, 'Base64'); } catch (e) { w = null; }
      if (!w || w.err !== 0) {
        console.warn('[ps] 原图缓存写入失败', w);
        return '';
      }
      return file;
    });
  }

  /**
   * 缩略图也落盘（t_<id>.jpg）
   *
   * 之前缩略图是 base64 塞在会话 JSON 里，几百段对话会把索引撑到几十 MB；
   * 写成小文件后，列表直接 file:// 加载，JSON 只留文件名。
   */
  function saveThumb(id, dataUrl) {
    var fs = fsApi();
    if (!fs || !hasCEP || !dataUrl) return Promise.resolve('');

    var b64 = String(dataUrl);
    var i = b64.indexOf(',');
    if (i >= 0) b64 = b64.slice(i + 1);

    var ext = HH.util.extOf(dataUrl);
    var file = 't_' + String(id || Date.now()).replace(/[^\w-]/g, '') + '.' + ext;

    return cacheDir().then(function (dir) {
      if (!dir) return '';
      var w = null;
      try { w = fs.writeFile(dir + '/' + file, b64, 'Base64'); } catch (e) { w = null; }
      return (w && w.err === 0) ? file : '';
    });
  }

  /**
   * 读回原图的 dataURL
   * @returns {Promise<string>} 失败返回 ''
   */
  function cacheLoad(file) {
    var fs = fsApi();
    if (!fs || !file) return Promise.resolve('');

    var ext = String(file).split('.').pop().toLowerCase();

    return cacheDir().then(function (dir) {
      if (!dir) return '';
      var rd = null;
      try { rd = fs.readFile(dir + '/' + file, 'Base64'); } catch (e) { rd = null; }
      if (!rd || rd.err !== 0 || !rd.data) return '';
      // CEP 的 readFile 会按 72 字符折行插换行，先清掉再拼 dataURL
      return 'data:' + (MIME_BY_EXT[ext] || 'image/png') + ';base64,' + String(rd.data).replace(/\s+/g, '');
    });
  }

  /** 删除缓存文件（删记录时顺手清，避免磁盘堆积） */
  function cacheRemove(file) {
    var fs = fsApi();
    if (!fs || !file) return;
    cacheDir().then(function (dir) {
      if (!dir) return;
      try { fs.deleteFile(dir + '/' + file); } catch (e) { /* 忽略 */ }
    });
  }

  /**
   * 取一张图的「原图」，统一入口。
   * 优先级：内存原图（刚生成 / 老数据内联）→ 磁盘缓存 → 缩略图
   *
   * @param {object} item history 条目（full/file/thumb）或会话结果（dataUrl/file/thumb）
   * @returns {Promise<string>} dataURL
   */
  function resolveImage(item) {
    if (!item) return Promise.resolve('');

    var direct = item.dataUrl || item.full || '';
    if (direct) return Promise.resolve(direct);

    var file = item.file || '';
    if (file) {
      return cacheLoad(file).then(function (d) { return d || item.thumb || ''; });
    }
    return Promise.resolve(item.thumb || '');
  }

  /**
   * 生成结果落库前的准备：原图写盘，返回要合并进 history 的字段
   * 没有磁盘（浏览器预览 / CEP fs 不可用）时退回内联 full
   */
  function persistImage(id, dataUrl) {
    if (!hasCEP) return Promise.resolve({ full: dataUrl });
    return cacheSave(id, dataUrl).then(function (file) {
      return file ? { file: file } : { full: dataUrl };
    });
  }

  /* ---------- JSX 热加载 ---------- */

  /**
   * 面板每次加载时，把 jsx/host.jsx 重新推给 ExtendScript 求值。
   *
   * 原因：CEP 的 <ScriptPath> 只在**扩展首次加载**时执行一次，
   * 改完 host.jsx 后重载面板并不会生效，会一直跑旧的函数（本次就踩了这个坑）。
   *
   * 面板初始化时宿主接口 / ExtendScript 引擎可能还没就绪，
   * 所以失败会自动重试（最多 6 次，间隔 250ms）。
   *
   * @param {number} [tries] 剩余重试次数
   */
  function loadJSX(tries) {
    if (!hasCEP) return Promise.resolve(false);

    var left = typeof tries === 'number' ? tries : 6;

    function retry() {
      if (left-- <= 0) return Promise.resolve(false);
      return new Promise(function (r) { setTimeout(r, 250); }).then(attempt);
    }

    function attempt() {
      var fs = fsApi();
      var dir = '';
      try { dir = new CSInterface().getSystemPath(CSInterface.SystemPath.EXTENSION); } catch (e) { dir = ''; }
      if (!fs || !dir) return retry();

      var path = String(dir).replace(/\\/g, '/').replace(/\/+$/, '') + '/jsx/host.jsx';
      var enc = (global.cep.encoding && global.cep.encoding.UTF8) || 'UTF-8';
      var r = null;
      try { r = fs.readFile(path, enc); } catch (e2) { r = null; }

      if (!r || r.err !== 0 || !r.data) {
        console.warn('[ps] 读取 host.jsx 失败', r && r.err, path);
        return retry();
      }

      // #target 只能出现在外部脚本文件里，字符串求值会报错，去掉
      var code = String(r.data).split(/\r?\n/).filter(function (line) {
        return !/^\s*#target/.test(line);
      }).join('\n');

      return evalScript(code).then(function (out) {
        // ExtendScript 语法错误时返回 "EvalScript error."，不算成功
        if (/EvalScript error/i.test(String(out))) {
          console.warn('[ps] JSX 求值报错，稍后重试');
          return retry();
        }
        HH._jsxLoaded = true;
        return true;
      }, function (e) {
        console.warn('[ps] JSX 热加载失败：' + e.message);
        return retry();
      });
    }

    return attempt();
  }

  // 由 app.js 在 DOM 就绪后调用（此处不自动执行：脚本加载阶段 ExtendScript 可能还没准备好）
  HH.ps = {
    available: hasCEP,
    evalScript: evalScript,
    insertImage: insertImage,
    parseInsertResult: parseInsertResult,
    insertTip: insertTip,
    setSmartInsert: function (v) { smartInsert = !!v; },
    getSmartInsert: function () { return smartInsert; },
    parseSize: parseSize,
    measure: measure,
    imageInfo: imageInfo,
    readSelection: readSelection,
    getDocInfo: getDocInfo,
    loadJSX: loadJSX,

    /* 原图磁盘缓存 */
    cacheDir: cacheDir,
    resetCacheDir: resetCacheDir,
    cacheSave: cacheSave,
    cacheLoad: cacheLoad,
    cacheRemove: cacheRemove,
    saveThumb: saveThumb,
    resolveImage: resolveImage,
    persistImage: persistImage
  };

})(window);
