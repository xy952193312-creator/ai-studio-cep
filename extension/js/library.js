/**
 * library.js — 本地资料库（对话记录 / 原图落盘）
 *
 * 为什么要这一层：
 *   localStorage 只有 5MB，一段对话塞几张图就满了，所以之前只能「最多保留 8 段」。
 *   现在对话与图片都写到用户指定的文件夹，条数只受磁盘限制，清缓存也不会丢。
 *
 * 目录结构（默认 %APPDATA%/AIStudio/data）：
 *   <dir>/index.json          会话索引（元数据：标题/时间/轮数/封面文件名）
 *   <dir>/sessions/<id>.json  单段会话的完整消息（图片只记文件名，不内联 base64）
 *   <dir>/images/<id>.png     生成结果原图（ps.js 的缓存目录会切到这里）
 *
 * 为什么索引和会话分开：
 *   启动时只读 index.json（几 KB），列表立刻能显示；
 *   双击某段对话时才读那一个 sessions/<id>.json，几百段也不会卡。
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};

  var K = 'aistudio.library.v1';

  var settings = (function () {
    try {
      var raw = localStorage.getItem(K);
      var o = raw ? JSON.parse(raw) : null;
      return { dir: (o && typeof o.dir === 'string') ? o.dir : '' };
    } catch (e) {
      return { dir: '' };
    }
  })();

  var prepared = false;     // 子目录是否已确认存在
  var preparing = null;     // 进行中的 ensure Promise（避免并发重复创建）

  /* ---------------- 基础 ---------------- */

  function available() {
    return !!(HH.ps && HH.ps.available);
  }

  function dir() {
    return String(settings.dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  }

  function imagesDir() {
    return dir() ? dir() + '/images' : '';
  }

  function sessionsDir() {
    return dir() ? dir() + '/sessions' : '';
  }

  /** 本地文件转成能在面板里显示的 URL（中文路径需要 encode） */
  function fileUrl(rel) {
    var d = dir();
    if (!d || !rel) return '';
    var p = d + '/' + String(rel).replace(/^\/+/, '');
    return 'file:///' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  function saveSettings() {
    try {
      localStorage.setItem(K, JSON.stringify(settings));
    } catch (e) { /* 忽略：目录设置丢了只是回到默认目录 */ }
  }

  function fsApi() {
    var c = global.cep;
    return (c && c.fs) ? c.fs : null;
  }

  function readText(path) {
    var fs = fsApi();
    if (!fs || typeof fs.readFile !== 'function') return Promise.resolve('');

    var r = null;
    try {
      r = fs.readFile(path, (global.cep.encoding && global.cep.encoding.UTF8) || 'UTF-8');
    } catch (e) { r = null; }

    if (!r || r.err !== 0 || !r.data) return Promise.resolve('');
    return Promise.resolve(String(r.data));
  }

  function writeText(path, text) {
    var fs = fsApi();
    if (!fs || typeof fs.writeFile !== 'function') return Promise.resolve(false);

    var w = null;
    try {
      w = fs.writeFile(path, String(text), 'UTF-8');
    } catch (e) { w = null; }

    return Promise.resolve(!!w && w.err === 0);
  }

  function evalOk(script) {
    if (!available()) return Promise.resolve('');
    return HH.ps.evalScript(script).catch(function () { return ''; });
  }

  /* ---------------- 目录 ---------------- */

  /**
   * 首次使用：把默认目录写进设置，再建子目录。
   * 已经选过目录就直接 ensure。
   */
  function init() {
    if (!available()) return Promise.resolve(false);

    if (dir()) return ensure();

    return evalOk('__aiDefaultDataDir()').then(function (raw) {
      var s = String(raw || '');
      if (s.indexOf('OK:') !== 0) return false;
      settings.dir = s.slice(3).replace(/\\/g, '/');
      saveSettings();
      return ensure();
    });
  }

  /** 确保 images/ 与 sessions/ 存在 */
  function ensure() {
    if (!dir()) return Promise.resolve(false);
    if (prepared) return Promise.resolve(true);
    if (preparing) return preparing;

    var d = dir();

    preparing = evalOk('__aiEnsureDir("' + esc(d) + '")')
      .then(function (r1) {
        if (String(r1).indexOf('OK:') !== 0) return false;
        return evalOk('__aiEnsureDir("' + esc(imagesDir()) + '")');
      })
      .then(function (r2) {
        if (String(r2).indexOf('OK:') !== 0) return false;
        return evalOk('__aiEnsureDir("' + esc(sessionsDir()) + '")');
      })
      .then(function (r3) {
        prepared = String(r3).indexOf('OK:') === 0;
        preparing = null;
        return prepared;
      }, function () {
        preparing = null;
        return false;
      });

    return preparing;
  }

  /** 切换存储目录 */
  function setDir(path) {
    var p = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p) return Promise.resolve(false);

    settings.dir = p;
    saveSettings();
    prepared = false;
    preparing = null;
    if (HH.ps && HH.ps.resetCacheDir) HH.ps.resetCacheDir();
    return ensure();
  }

  /** 统一成正斜杠、折叠重复斜杠、去掉末尾斜杠（UNC 的 `//server` 要保住） */
  function norm(p) {
    var s = String(p || '').replace(/\\/g, '/');

    var unc = s.indexOf('//') === 0;
    if (unc) s = s.slice(2);

    s = s.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return unc ? '//' + s : s;
  }

  /**
   * 判断某一项是不是文件夹
   *
   * CEP 11 的 fs 接口很简陋：readdir 只返回名字数组（不是 {name,isFile}），
   * stat 也只返回 mtime —— 没有任何字段能直接看出目录还是文件。
   * 所以只能试读：能 readdir 成功的就是目录，文件会返回 err != 0。
   */
  function isDirEntry(fs, base, name) {
    try {
      var r = fs.readdir(joinPath(base, name));
      return !!(r && r.err === 0);
    } catch (e) {
      return false;      // 没权限之类的，就不当目录列出来
    }
  }

  /**
   * 列目录（给面板内的文件夹浏览器用）
   *
   * 为什么要自己做一个浏览器：
   *   系统文件夹对话框有两个坑 —— ExtendScript 的 Folder.selectDialog 会锁死 PS 主线程；
   *   cep.fs.showOpenDialogEx 虽然不锁 PS，但它是同步阻塞的，一旦被窗口层级挡住看不见，
   *   面板就会一直卡在「选择中…」，用户只能重开面板甚至重启 PS。
   *   面板内自建的浏览器完全跑在页面里，不依赖任何宿主对话框，最坏也只是点不动列表。
   *
   * @returns {Promise<{ok:boolean, path?:string, dirs?:string[], files?:number, message?:string}>}
   */
  function listDir(p) {
    var fs = fsApi();
    if (!fs || typeof fs.readdir !== 'function') {
      return Promise.resolve({ ok: false, message: '文件系统接口不可用' });
    }

    var path = norm(p || dir());
    if (!path) return Promise.resolve({ ok: false, message: '还没有可用路径' });

    // 盘符根要带上斜杠才能读（'C:' 在 Windows 上是相对路径）
    var readPath = /^[a-zA-Z]:$/.test(path) ? path + '/' : path;

    var r = null;
    try {
      r = fs.readdir(readPath);
    } catch (e) {
      return Promise.resolve({ ok: false, path: path, message: '读不了这个文件夹：' + (e.message || e) });
    }

    if (!r || r.err !== 0) {
      return Promise.resolve({ ok: false, path: path, message: '读不了这个文件夹（可能没有访问权限）' });
    }

    var dirs = [];
    var files = 0;

    (r.data || []).forEach(function (it) {
      // 老版本给对象，新版本给字符串，两种都接住
      var name = (it && typeof it === 'object') ? it.name : it;
      if (!name) return;

      var isDir;
      if (it && typeof it === 'object' && typeof it.isFile === 'boolean') {
        isDir = !it.isFile;
      } else {
        isDir = isDirEntry(fs, path, name);
      }

      if (isDir) dirs.push(name);
      else files++;
    });

    dirs.sort(function (a, b) { return a.localeCompare(b); });
    return Promise.resolve({ ok: true, path: path, dirs: dirs, files: files });
  }

  /** 上一层目录；盘符根已经到顶就返回自己 */
  function parentOf(p) {
    var s = norm(p);
    if (!s) return '';

    // 盘符根：C:/ 或 /
    if (/^[a-zA-Z]:$/.test(s) || s === '') return s;
    if (s === '/' || /^\/\/[^\/]+$/.test(s)) return s;

    var i = s.lastIndexOf('/');
    if (i <= 0) return s.slice(0, 1) === '/' ? '/' : s.slice(0, i + 1).replace(/\/+$/, '');
    return s.slice(0, i);
  }

  /** 拼路径，注意别把盘符根拼成 C:// */
  function joinPath(base, name) {
    var b = norm(base);
    if (!b) return norm(name);
    return b + '/' + String(name || '').replace(/^\/+/, '');
  }

  /** 判断是不是盘符根（用来决定要不要显示「上一级」） */
  function isRoot(p) {
    var s = norm(p);
    return /^[a-zA-Z]:$/.test(s) || s === '/' || /^\/\/[^\/]+\/[^\/]+$/.test(s);
  }

  /**
   * 选择文件夹 —— 主路径：CEP 原生对话框
   *
   * 注意：这个函数**默认不再被 UI 调用**（改走面板内浏览器，见 listDir）。
   * 系统对话框是同步阻塞的，被挡住时会让面板卡住，只在明确需要时用。
   *
   * @returns {Promise<{ok:boolean, path?:string, cancel?:boolean, message?:string}>}
   */
  function pickDir() {
    if (!available()) {
      return Promise.resolve({ ok: false, message: '当前不在 Photoshop 面板中' });
    }

    var fs = fsApi();
    if (fs && typeof fs.showOpenDialogEx === 'function') {
      var r = null;
      try {
        var start = dir();
        r = start
          ? fs.showOpenDialogEx(false, true, '选择对话记录存储文件夹', start)
          : fs.showOpenDialogEx(false, true, '选择对话记录存储文件夹');
      } catch (e) {
        r = null;                        // 抛异常就当不支持，回退到 JSX 版本
      }

      if (r) {
        if (r.err === 0) {
          // 多数版本给数组，个别版本直接给字符串，两种都接住
          var list = r.data;
          if (typeof list === 'string') list = list ? [list] : [];
          if (!list) list = [];

          // err 为 0 但取不到路径 = 用户在对话框里点了取消
          return Promise.resolve(list.length
            ? { ok: true, path: norm(list[0]) }
            : { ok: false, cancel: true });
        }
        return Promise.resolve({ ok: false, message: '打开文件夹对话框失败（错误码 ' + r.err + '）' });
      }
    }

    /* 回退：老版本 CEP 没有 showOpenDialogEx，只能走 ExtendScript */
    return HH.ps.evalScript('__aiPickFolder("' + esc(dir()) + '")').then(function (raw) {
      var s = String(raw || '').trim();
      if (s.indexOf('OK:') === 0) return { ok: true, path: norm(s.slice(3)) };
      if (s === 'CANCEL') return { ok: false, cancel: true };
      return { ok: false, message: s.replace(/^ERR:\s*/, '') || '选择文件夹失败' };
    }, function (e) {
      // evalScript 挂住超过上限会 reject，这里要如实告诉用户，不能吞
      return { ok: false, message: (e && e.message) || '调用 Photoshop 失败' };
    });
  }

  function openDir() {
    if (!dir()) return;
    evalOk('__aiOpenFolder("' + esc(dir()) + '")');
  }

  /** 打开资料库下的子目录（如 images） */
  function openSub(sub) {
    var d = dir();
    if (!d) return;
    evalOk('__aiOpenFolder("' + esc(d + '/' + String(sub || '').replace(/^\/+|\/+$/g, '')) + '")');
  }

  /* ---------------- 读写 ---------------- */

  function indexFile() {
    return dir() + '/index.json';
  }

  function sessionFile(id) {
    return sessionsDir() + '/' + String(id).replace(/[^\w-]/g, '') + '.json';
  }

  /**
   * 写索引
   * @param {Array} metas 每段的元数据（不含消息体）
   */
  function writeIndex(metas) {
    if (!dir()) return Promise.resolve(false);
    return ensure().then(function (ok) {
      if (!ok) return false;
      var payload = { version: 1, savedAt: Date.now(), sessions: metas || [] };
      return writeText(indexFile(), JSON.stringify(payload));
    });
  }

  /** 读索引；文件不存在 / 损坏时返回 [] */
  function readIndex() {
    if (!dir()) return Promise.resolve([]);
    return readText(indexFile()).then(function (text) {
      if (!text) return [];
      try {
        var o = JSON.parse(text);
        var list = o && Array.isArray(o.sessions) ? o.sessions : (Array.isArray(o) ? o : []);
        return list.filter(function (m) { return m && m.id; });
      } catch (e) {
        console.warn('[lib] index.json 解析失败', e);
        return [];
      }
    });
  }

  /** 写单段会话（sess 需已瘦身：不含 dataURL） */
  function saveSession(sess) {
    if (!dir() || !sess || !sess.id) return Promise.resolve(false);

    return ensure().then(function (ok) {
      if (!ok) return false;
      return writeText(sessionFile(sess.id), JSON.stringify(sess));
    });
  }

  /** 读单段会话；不存在返回 null */
  function loadSession(id) {
    if (!dir() || !id) return Promise.resolve(null);

    return readText(sessionFile(id)).then(function (text) {
      if (!text) return null;
      try {
        var o = JSON.parse(text);
        return (o && typeof o === 'object') ? o : null;
      } catch (e) {
        console.warn('[lib] 会话文件解析失败', id, e);
        return null;
      }
    });
  }

  function deleteSession(id) {
    if (!dir() || !id) return Promise.resolve(false);
    var fs = fsApi();
    if (!fs || typeof fs.deleteFile !== 'function') return Promise.resolve(false);

    var r = null;
    try { r = fs.deleteFile(sessionFile(id)); } catch (e) { r = null; }
    return Promise.resolve(!!r && r.err === 0);
  }

  /** 目录统计：{ sessions, images, bytes } */
  function stat() {
    if (!dir()) return Promise.resolve({ sessions: 0, images: 0, bytes: 0 });

    return evalOk('__aiDirStat("' + esc(sessionsDir()) + '")').then(function (a) {
      return evalOk('__aiDirStat("' + esc(imagesDir()) + '")').then(function (b) {
        var s1 = parseStat(a), s2 = parseStat(b);
        return {
          sessions: s1.n,
          images: s2.n,
          bytes: s1.size + s2.size
        };
      });
    });
  }

  /**
   * 把当前 images/ 下的所有图片复制到目标目录的 images/
   *
   * 切换存储文件夹时用：会话 JSON 会重写，图片是二进制，只能靠 ExtendScript 搬。
   * @returns {Promise<number>} 复制成功的文件数
   */
  function copyImagesTo(targetDir) {
    if (!dir() || !targetDir) return Promise.resolve(0);

    var dst = String(targetDir).replace(/\\/g, '/').replace(/\/+$/, '') + '/images';

    return evalOk('__aiCopyFiles("' + esc(imagesDir()) + '","' + esc(dst) + '")')
      .then(function (raw) {
        var s = String(raw || '');
        if (s.indexOf('OK:') !== 0) {
          console.warn('[lib] 图片复制失败', s);
          return 0;
        }
        return parseInt(s.slice(3), 10) || 0;
      });
  }

  /** 只清空 sessions/（保留图片与索引） */
  function clearSessions() {
    if (!dir()) return Promise.resolve(false);

    return evalOk('__aiClearDir("' + esc(sessionsDir()) + '")').then(function () {
      return true;
    });
  }

  /** 清空 sessions/ 与 images/ 下的文件（保留目录） */
  function clearAll() {
    if (!dir()) return Promise.resolve(false);

    return evalOk('__aiClearDir("' + esc(sessionsDir()) + '")').then(function () {
      return evalOk('__aiClearDir("' + esc(imagesDir()) + '")');
    }).then(function () {
      return evalOk('__aiClearDir("' + esc(dir()) + '")');
    }).then(function () {
      return true;
    });
  }

  /* ---------------- 工具 ---------------- */

  function esc(p) {
    return String(p || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function parseStat(raw) {
    var s = String(raw || '');
    if (s.indexOf('OK:') !== 0) return { n: 0, size: 0 };
    var parts = s.slice(3).split('|');
    return { n: parseInt(parts[0], 10) || 0, size: parseInt(parts[1], 10) || 0 };
  }

  /** 人类可读的体积 */
  function humanSize(bytes) {
    var b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  HH.lib = {
    available: available,
    usable: function () { return available() && !!dir(); },

    init: init,
    ensure: ensure,
    dir: dir,
    imagesDir: imagesDir,
    sessionsDir: sessionsDir,
    fileUrl: fileUrl,

    setDir: setDir,
    pickDir: pickDir,
    listDir: listDir,
    parentOf: parentOf,
    joinPath: joinPath,
    isRoot: isRoot,
    openDir: openDir,
    openSub: openSub,
    copyImagesTo: copyImagesTo,

    writeIndex: writeIndex,
    readIndex: readIndex,
    saveSession: saveSession,
    loadSession: loadSession,
    deleteSession: deleteSession,

    stat: stat,
    clearSessions: clearSessions,
    clearAll: clearAll,
    humanSize: humanSize
  };

})(window);
