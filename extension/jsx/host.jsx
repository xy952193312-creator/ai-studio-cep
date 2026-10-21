/**
 * host.jsx — Photoshop 宿主脚本（ExtendScript）
 * 由 CEP 面板通过 evalScript 调用。
 */

#target photoshop

/**
 * 取当前选区导出为临时 PNG（无选区则导出整张图）
 * 面板侧用 cep.fs.readFile 读成 base64，再作为参考图上传。
 *
 * @returns {string} "OK:路径|宽x高|是否有选区|left,top" 或 "ERR:原因"
 */
function __aiGetSelection() {
  var doc = null;
  var tempDoc = null;
  var prevDialogs = app.displayDialogs;

  // 选区 bounds 可能是 UnitValue 也可能是数字，统一取像素值
  function px(v) {
    try { return v.as('px'); } catch (e) { return Number(v) || 0; }
  }

  try {
    if (app.documents.length === 0) {
      return 'ERR:请先在 Photoshop 中打开一张图';
    }

    doc = app.activeDocument;

    // 避免「粘贴配置文件」等弹窗卡住脚本
    app.displayDialogs = DialogModes.NO;

    var hasSel = true;
    var b = null;
    try {
      b = doc.selection.bounds;
    } catch (eSel) {
      hasSel = false;
    }

    var w, h;
    var left = 0;
    var top = 0;

    if (hasSel) {
      left = px(b[0]);
      top = px(b[1]);
      w = Math.max(1, Math.round(px(b[2]) - left));
      h = Math.max(1, Math.round(px(b[3]) - top));
      doc.selection.copy();
    } else {
      // 无选区：整个画布
      w = Math.max(1, Math.round(px(doc.width)));
      h = Math.max(1, Math.round(px(doc.height)));
      doc.selection.selectAll();
      doc.selection.copy();
      doc.selection.deselect();
    }

    // 用原文档分辨率新建，否则粘贴会按物理尺寸缩放
    var res = 72;
    try { res = doc.resolution; } catch (eRes) { res = 72; }

    tempDoc = app.documents.add(
      UnitValue(w, 'px'),
      UnitValue(h, 'px'),
      res,
      'aistudio_sel',
      NewDocumentMode.RGB,
      DocumentFill.TRANSPARENT,
      1,
      BitsPerChannelType.EIGHT,
      'sRGB IEC61966-2.1'
    );

    tempDoc.paste();
    try { tempDoc.flatten(); } catch (eFlat) { /* 单图层时无需拼合 */ }

    // 超大选区缩到 4096 以内，避免 base64 撑爆面板内存
    var MAX_SIDE = 4096;
    if (w > MAX_SIDE || h > MAX_SIDE) {
      var k = MAX_SIDE / Math.max(w, h);
      var nw = Math.max(1, Math.round(w * k));
      var nh = Math.max(1, Math.round(h * k));
      try {
        tempDoc.resizeImage(UnitValue(nw, 'px'), UnitValue(nh, 'px'), null, ResampleMethod.BICUBIC);
        w = nw;
        h = nh;
      } catch (eScale) { /* 缩放失败就按原尺寸导出 */ }
    }

    var path = Folder.temp.fsName + '/aistudio_sel_' + new Date().getTime() + '.png';
    var opts = new PNGSaveOptions();
    tempDoc.saveAs(new File(path), opts, true, Extension.LOWERCASE);
    tempDoc.close(SaveOptions.DONOTSAVECHANGES);
    tempDoc = null;

    app.activeDocument = doc;
    app.displayDialogs = prevDialogs;

    return 'OK:' + path.replace(/\\/g, '/') + '|' + w + 'x' + h + '|' +
      (hasSel ? '1' : '0') + '|' + Math.round(left) + ',' + Math.round(top);

  } catch (err) {
    try { if (tempDoc) tempDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e1) {}
    try { if (doc) app.activeDocument = doc; } catch (e2) {}
    try { app.displayDialogs = prevDialogs; } catch (e3) {}
    return 'ERR:' + (err.message || err);
  }
}


/**
 * 返回 "文档名|宽x高"
 */
function __aiGetDocInfo() {
  try {
    if (app.documents.length === 0) return 'NO_DOC';
    var d = app.activeDocument;
    return d.name + '|' + Math.round(d.width.as('px')) + 'x' + Math.round(d.height.as('px'));
  } catch (e) {
    return 'ERR:' + e.message;
  }
}

/**
 * 将指定图片文件作为新图层插入当前文档
 *
 * 关键行为：**插入到当前选区内**。
 *   - 有选区：等比放大/缩小铺满选区（cover），居中，再把溢出选区的部分裁掉；
 *   - 无选区：按整张画布等比放下（contain）并居中；
 *   - mode='canvas' 强制忽略选区。
 *
 * 这样即使生成的是 2K 图、选区只有 1K，贴进去的图层也正好占满选区。
 *
 * @param {string} path 图片绝对路径（正斜杠）
 * @param {string} hint 图层名前缀
 * @param {string} mode 'selection' | 'canvas'
 * @returns {string} "OK:图层名|sel|源图宽x源图高|插入后宽x插入后高" 或 "ERR:原因"
 *
 * 为什么要回传「源图尺寸」：
 * 之前只返回插入后的 bounds，于是「1024 原图插进 1024 选区」和
 * 「360 缩略图被放大 2.8 倍插进 1024 选区」返回的都是 1024x1024 ——
 * 用户（和开发者）根本分不清到底插的是原图还是缩略图。
 * 现在面板可以拿源图尺寸跟插入尺寸对比，放大超过 1.05 倍就提示「会模糊」。
 */
function __aiInsertLayer(path, hint, mode) {
  var targetDoc = null;
  var srcDoc = null;
  var prevDialogs = app.displayDialogs;

  // bounds 元素可能是 UnitValue，也可能直接是数字
  function px(v) {
    try { return v.as('px'); } catch (e) { return Number(v) || 0; }
  }

  try {
    var f = new File(path);
    if (!f.exists) return 'ERR:文件不存在 ' + path;

    // 没有打开文档：直接作为新文档打开
    if (app.documents.length === 0) {
      app.open(f);
      return 'OK:已新建文档|canvas|';
    }

    app.displayDialogs = DialogModes.NO;
    targetDoc = app.activeDocument;

    // ---- 1. 取选区 ----
    var sel = null;
    try {
      var b = targetDoc.selection.bounds;
      sel = {
        l: px(b[0]),
        t: px(b[1]),
        w: Math.max(1, px(b[2]) - px(b[0])),
        h: Math.max(1, px(b[3]) - px(b[1]))
      };
    } catch (eSel) {
      sel = null;
    }

    var useSel = (mode !== 'canvas') && sel;

    // ---- 2. 打开生成图，按目标尺寸缩放 ----
    srcDoc = app.open(f);
    app.activeDocument = srcDoc;

    var sw = px(srcDoc.width);
    var sh = px(srcDoc.height);
    if (!sw || !sh) throw new Error('图片尺寸读取失败');

    var tw, th, k;
    if (useSel) {
      tw = sel.w;
      th = sel.h;
      k = Math.max(tw / sw, th / sh);          // cover：铺满，允许溢出（随后裁掉）
    } else {
      var cw = px(targetDoc.width);
      var ch = px(targetDoc.height);
      k = Math.min(cw / sw, ch / sh);          // contain：整张放得下
      if (k > 1) k = 1;                        // 小图不放大
      tw = Math.round(sw * k);
      th = Math.round(sh * k);
    }

    if (Math.abs(k - 1) > 0.005) {
      srcDoc.resizeImage(
        UnitValue(Math.max(1, Math.round(sw * k)), 'px'),
        UnitValue(Math.max(1, Math.round(sh * k)), 'px'),
        null,
        ResampleMethod.BICUBICSHARPER
      );
    }

    // ---- 3. 复制到目标文档 ----
    var dup = srcDoc.activeLayer.duplicate(targetDoc, ElementPlacement.PLACEATBEGINNING);
    srcDoc.close(SaveOptions.DONOTSAVECHANGES);
    srcDoc = null;
    app.activeDocument = targetDoc;

    var layerName = (hint || 'AI') + '_' + new Date().getTime();
    try { dup.name = layerName; } catch (eName) { /* 名称被锁则忽略 */ }

    // ---- 4. 居中到选区（或画布中心） ----
    var lb = dup.bounds;
    var lw = px(lb[2]) - px(lb[0]);
    var lh = px(lb[3]) - px(lb[1]);

    var cx = useSel ? (sel.l + sel.w / 2) : px(targetDoc.width) / 2;
    var cy = useSel ? (sel.t + sel.h / 2) : px(targetDoc.height) / 2;

    var dx = cx - (px(lb[0]) + lw / 2);
    var dy = cy - (px(lb[1]) + lh / 2);

    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      dup.translate(UnitValue(dx, 'px'), UnitValue(dy, 'px'));
    }

    // ---- 5. 裁掉溢出选区的部分，并还原用户原来的选区 ----
    if (useSel) {
      try {
        targetDoc.activeLayer = dup;
        targetDoc.selection.invert();
        targetDoc.selection.clear();
        targetDoc.selection.invert();
      } catch (eClip) { /* 裁切失败不影响已插入的结果 */ }
    }

    var fb = dup.bounds;
    var fw = Math.round(px(fb[2]) - px(fb[0]));
    var fh = Math.round(px(fb[3]) - px(fb[1]));

    app.displayDialogs = prevDialogs;

    // 源图尺寸（缩放前）也要回传，面板据此判断「插的是原图还是被放大的缩略图」
    var swOut = Math.round(sw);
    var shOut = Math.round(sh);

    // raster + nomask：这条路径是 resizeImage 重采样 + selection.clear() 硬裁，
    // 裁掉的部分真的被删了，提示语里不能说「可恢复」
    return 'OK:' + layerName + '|' + (useSel ? 'sel' : 'canvas') + '|' +
           swOut + 'x' + shOut + '|' + fw + 'x' + fh + '|raster' + (useSel ? '|nomask' : '');

  } catch (err) {
    try { if (srcDoc && srcDoc !== targetDoc) srcDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e1) {}
    try { if (targetDoc) app.activeDocument = targetDoc; } catch (e2) {}
    try { app.displayDialogs = prevDialogs; } catch (e3) {}
    return 'ERR:' + (err.message || err);
  }
}


/**
 * 以「智能对象」方式插入（非破坏性版本）
 *
 * 与 __aiInsertLayer 的区别 —— 那套是「重采样 + 硬裁」：
 *   1. resizeImage() 直接改写像素，1024 缩到 860 后原始像素就没了；
 *   2. selection.clear() 把溢出选区的画面**删掉**，事后想找回来不可能。
 *
 * 这一版改成：
 *   1. 原样 duplicate 进来（像素不动），再 newPlacedLayer 转成智能对象；
 *   2. 缩放用 layer.resize —— 对智能对象这是**变换矩阵**，原始 1024 仍在；
 *   3. 裁边用**图层蒙版**代替 clear()，被遮住的画面随时删蒙版就能恢复。
 *
 * 收益不在「画质」（缩小本来就不损失），而在可逆：
 * 裁错了能恢复、后续反复缩放不累积损失、双击图层能编辑原始内容。
 *
 * @param {string} path 图片绝对路径（正斜杠）
 * @param {string} hint 图层名前缀
 * @param {string} mode 'selection' | 'canvas'
 * @returns {string} "OK:图层名|sel|源图宽x源图高|可见宽x可见高|smart|raster"
 *          最后一段是实际落地的图层类型（转智能对象失败会退回 raster）
 */
function __aiInsertSmart(path, hint, mode) {
  var prevDialogs = app.displayDialogs;
  var prevRuler = null;
  var prevType = null;
  var startDoc = null;
  var srcDoc = null;

  // bounds 元素可能是 UnitValue，也可能直接是数字
  function px(v) {
    try { return v.as('px'); } catch (e) { return Number(v) || 0; }
  }

  /** 用当前选区给图层加蒙版（显示选区内 = 遮住选区外），非破坏性 */
  function maskFromSelection() {
    var desc = new ActionDescriptor();
    desc.putClass(charIDToTypeID('Nw  '), charIDToTypeID('Chnl'));
    var ref = new ActionReference();
    ref.putEnumerated(charIDToTypeID('Chnl'), charIDToTypeID('Chnl'), charIDToTypeID('Msk '));
    desc.putReference(charIDToTypeID('At  '), ref);
    desc.putEnumerated(charIDToTypeID('Usng'), charIDToTypeID('UsrM'), charIDToTypeID('RvlS'));
    executeAction(charIDToTypeID('Mk  '), desc, DialogModes.NO);
  }

  function restorePrefs() {
    try { app.displayDialogs = prevDialogs; } catch (e1) {}
    try { if (prevRuler !== null) app.preferences.rulerUnits = prevRuler; } catch (e2) {}
    try { if (prevType !== null) app.preferences.typeUnits = prevType; } catch (e3) {}
  }

  try {
    var f = new File(path);
    if (!f.exists) return 'ERR:文件不存在 ' + path;

    // 没有打开文档：直接作为新文档打开
    if (app.documents.length === 0) {
      app.open(f);
      return 'OK:已新建文档|canvas|||raster';
    }

    app.displayDialogs = DialogModes.NO;
    try { prevRuler = app.preferences.rulerUnits; app.preferences.rulerUnits = Units.PIXELS; } catch (eR) {}
    try { prevType = app.preferences.typeUnits; app.preferences.typeUnits = TypeUnits.PIXELS; } catch (eT) {}

    startDoc = app.activeDocument;

    // ---- 1. 取选区 ----
    var sel = null;
    try {
      var b = startDoc.selection.bounds;
      sel = {
        l: px(b[0]),
        t: px(b[1]),
        w: Math.max(1, px(b[2]) - px(b[0])),
        h: Math.max(1, px(b[3]) - px(b[1]))
      };
    } catch (eSel) { sel = null; }

    var useSel = (mode !== 'canvas') && sel;

    // ---- 2. 打开源图，只为了读原始尺寸（不缩放、不改像素） ----
    srcDoc = app.open(f);
    var srcW = Math.round(px(srcDoc.width));
    var srcH = Math.round(px(srcDoc.height));
    if (!srcW || !srcH) throw new Error('图片尺寸读取失败');

    // ---- 3. 原样拷进目标文档：像素一动不动 ----
    var dup = srcDoc.activeLayer.duplicate(startDoc, ElementPlacement.PLACEATBEGINNING);
    srcDoc.close(SaveOptions.DONOTSAVECHANGES);
    srcDoc = null;
    app.activeDocument = startDoc;
    startDoc.activeLayer = dup;

    // ---- 4. 转智能对象：此后所有缩放都是变换，原始 1024 完整保留 ----
    var isSmart = false;
    try {
      executeAction(stringIDToTypeID('newPlacedLayer'), undefined, DialogModes.NO);
      // 转换后图层引用可能失效，重新取一次
      dup = startDoc.activeLayer;
      startDoc.activeLayer = dup;
      isSmart = (dup.kind === LayerKind.SMARTOBJECT);
    } catch (eSO) {
      isSmart = false;   // 转不了就当普通图层继续，不中断插入
    }

    // ---- 5. 等比缩放到目标（cover：铺满选区，允许溢出后由蒙版遮住） ----
    var tw, th;
    if (useSel) {
      tw = sel.w;
      th = sel.h;
    } else {
      var cw = px(startDoc.width);
      var ch = px(startDoc.height);
      var kc = Math.min(cw / srcW, ch / srcH);   // contain：整张放得下
      if (kc > 1) kc = 1;                        // 小图不放大
      tw = Math.round(srcW * kc);
      th = Math.round(srcH * kc);
    }

    var lb = dup.bounds;
    var lw = px(lb[2]) - px(lb[0]);
    var lh = px(lb[3]) - px(lb[1]);
    if (!lw || !lh) throw new Error('图层尺寸读取失败');

    var scale = Math.max(tw / lw, th / lh) * 100;
    if (Math.abs(scale - 100) > 0.5) {
      dup.resize(scale, scale, AnchorPosition.MIDDLECENTER);
    }

    // ---- 6. 居中到选区（或画布中心） ----
    var lb2 = dup.bounds;
    var l2w = px(lb2[2]) - px(lb2[0]);
    var l2h = px(lb2[3]) - px(lb2[1]);
    var cx = useSel ? (sel.l + sel.w / 2) : px(startDoc.width) / 2;
    var cy = useSel ? (sel.t + sel.h / 2) : px(startDoc.height) / 2;
    var dx = cx - (px(lb2[0]) + l2w / 2);
    var dy = cy - (px(lb2[1]) + l2h / 2);
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      dup.translate(UnitValue(dx, 'px'), UnitValue(dy, 'px'));
    }

    // ---- 7. 裁边：用蒙版遮住溢出部分，而不是 clear() 删掉 ----
    var masked = false;
    if (useSel) {
      startDoc.activeLayer = dup;
      try { maskFromSelection(); masked = true; } catch (eMask) { masked = false; }
    }

    var layerName = (hint || 'AI') + '_' + new Date().getTime();
    try { dup.name = layerName; } catch (eN) {}

    var fb = dup.bounds;
    var fw = Math.round(px(fb[2]) - px(fb[0]));
    var fh = Math.round(px(fb[3]) - px(fb[1]));

    restorePrefs();

    return 'OK:' + layerName + '|' + (useSel ? 'sel' : 'canvas') + '|' +
           srcW + 'x' + srcH + '|' + fw + 'x' + fh + '|' +
           (isSmart ? 'smart' : 'raster') + (masked ? '' : '|nomask');

  } catch (err) {
    try { if (srcDoc && srcDoc !== startDoc) srcDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e1) {}
    try { if (startDoc) app.activeDocument = startDoc; } catch (e2) {}
    restorePrefs();
    return 'ERR:' + (err.message || err);
  }
}


/**
 * 原图缓存目录
 *
 * 面板的 localStorage 只有 5MB，1024 图最多存几张；所以生成结果的原图
 * 落到磁盘（%APPDATA%/AIStudio/cache），localStorage 里只记文件名。
 *
 * 选 userData 而不是 temp：temp 会被系统清理，历史记录就再也读不到原图。
 * 目录不存在时逐级创建（ExtendScript 的 Folder.create 不会自动建父目录）。
 *
 * @return {string} "OK:<路径>" 或 "ERR:<原因>"
 */
function __aiCacheDir() {
  try {
    var base = Folder.userData;
    var segments = ['AIStudio', 'cache'];
    var cur = base;

    for (var i = 0; i < segments.length; i++) {
      var next = new Folder(cur.fsName + '/' + segments[i]);
      if (!next.exists && !next.create()) {
        return 'ERR:无法创建缓存目录 ' + next.fsName;
      }
      cur = next;
    }

    return 'OK:' + cur.fsName.replace(/\\/g, '/');
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}

/**
 * 诊断日志目录
 *
 * 与 cache 同级（userData/AIStudio/logs），选 userData 而非 temp 是怕被系统清理。
 * 面板灰屏时页面打不开，只有落盘的日志能事后取证，所以这个目录要在
 * 页面刚起来就能用 —— 创建失败也不能抛，返回 ERR 让面板侧降级成「只记内存」。
 *
 * @return {string} "OK:<路径>" 或 "ERR:<原因>"
 */
function __aiLogDir() {
  try {
    var base = Folder.userData;
    var segments = ['AIStudio', 'logs'];
    var cur = base;

    for (var i = 0; i < segments.length; i++) {
      var next = new Folder(cur.fsName + '/' + segments[i]);
      if (!next.exists && !next.create()) {
        return 'ERR:无法创建日志目录 ' + next.fsName;
      }
      cur = next;
    }

    return 'OK:' + cur.fsName.replace(/\\/g, '/');
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}


/* ============================================================
   本地资料库：目录 / 列举 / 统计 / 清理
   面板侧 js/library.js 调这些函数，把对话记录与图片存到用户指定目录。
   ============================================================ */

/**
 * 默认数据目录：%APPDATA%/AIStudio/data
 *
 * 用 userData 而不是 temp：temp 会被系统清理，历史记录就再也读不到原图。
 */
function __aiDefaultDataDir() {
  try {
    return 'OK:' + Folder.userData.fsName.replace(/\\/g, '/') + '/AIStudio/data';
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}

/**
 * 逐级创建目录（Folder.create 不会自动建父目录）
 * @return {string} "OK:<真实路径>" | "ERR:<原因>"
 */
function __aiEnsureDir(path) {
  try {
    var target = new Folder(String(path).replace(/\\/g, '/'));
    if (target.exists) return 'OK:' + target.fsName;

    // 先往上找到已存在的祖先，再逐级 create
    var stack = [];
    var cur = target;
    var guard = 0;

    while (cur && !cur.exists && guard++ < 64) {
      stack.unshift(cur);
      var parent = cur.parent;
      if (!parent || parent.fsName === cur.fsName) break;
      cur = parent;
    }

    for (var i = 0; i < stack.length; i++) {
      if (!stack[i].exists && !stack[i].create()) {
        return 'ERR:无法创建目录 ' + stack[i].fsName;
      }
    }

    return target.exists ? 'OK:' + target.fsName : 'ERR:目录创建失败 ' + target.fsName;
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}

/**
 * 列出目录下的文件名（不递归）
 * @return {string} "OK:name1|name2" （无文件时 "OK:"）
 */
function __aiListFiles(dir) {
  try {
    var f = new Folder(String(dir).replace(/\\/g, '/'));
    if (!f.exists) return 'OK:';

    var list = f.getFiles();
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item instanceof Folder) continue;
      var name = item.displayName || item.name;
      out.push(decodeURI(name));
    }

    return 'OK:' + out.join('|');
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}

/**
 * 统计目录下的文件数与总字节（不递归，目录本身是扁平的）
 * @return {string} "OK:<文件数>|<字节数>"
 */
function __aiDirStat(dir) {
  try {
    var f = new Folder(String(dir).replace(/\\/g, '/'));
    if (!f.exists) return 'OK:0|0';

    var list = f.getFiles();
    var n = 0, size = 0;

    for (var i = 0; i < list.length; i++) {
      if (list[i] instanceof Folder) continue;
      n++;
      size += Number(list[i].length) || 0;
    }

    return 'OK:' + n + '|' + size;
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}

/**
 * 清空目录下的文件（保留目录本身）
 * @return {string} "OK:<删除数>" | "ERR:<原因>"
 */
function __aiClearDir(dir) {
  try {
    var f = new Folder(String(dir).replace(/\\/g, '/'));
    if (!f.exists) return 'OK:0';

    var list = f.getFiles();
    var n = 0;

    for (var i = 0; i < list.length; i++) {
      if (list[i] instanceof Folder) continue;
      if (list[i].remove()) n++;
    }

    return 'OK:' + n;
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}

/**
 * 弹出「选择文件夹」对话框（备用路径）
 *
 * 注意：这是同步模态调用，会锁住 PS 主线程。面板侧平时走
 * cep.fs.showOpenDialogEx，只有老版本 CEP 没有那个 API 时才落到这里。
 *
 * @return {string} "OK:<路径>" | "CANCEL" | "ERR:原因"
 */
function __aiPickFolder(current) {
  try {
    // 面板是独立浮窗，PS 主窗口不在前台时弹出来的对话框容易被压在后面
    try { app.bringToFront(); } catch (e0) {}

    var start = null;
    try { start = current ? new Folder(String(current).replace(/\\/g, '/')) : Folder.userData; } catch (e1) { start = null; }
    if (!start || !start.exists) start = Folder.userData;

    // 实例版能指定「从哪个文件夹开始」，但个别 PS 版本的 Folder 上没有这个方法；
    // 静态版 Folder.selectDialog() 一定有，只是不认起始目录。
    var picked = null;
    try {
      picked = start.selectDialog('选择对话记录存储文件夹');
    } catch (e2) {
      picked = Folder.selectDialog('选择对话记录存储文件夹');
    }
    if (!picked) return 'CANCEL';

    return 'OK:' + picked.fsName.replace(/\\/g, '/');
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}

/** 在资源管理器里打开目录 */
function __aiOpenFolder(path) {
  try {
    var f = new Folder(String(path).replace(/\\/g, '/'));
    if (!f.exists) return 'ERR:目录不存在';
    f.execute();
    return 'OK';
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}


/**
 * 复制目录下的所有文件到另一个目录（不递归，图片目录是扁平的）
 *
 * 切换存储文件夹时用：会话 JSON 会被重写，但图片是二进制文件，
 * 面板侧没有 Node fs，只能用 ExtendScript 的 File.copy 搬过去。
 *
 * @return {string} "OK:<复制数>" | "ERR:<原因>"
 */
function __aiCopyFiles(src, dst) {
  try {
    var s = new Folder(String(src).replace(/\\/g, '/'));
    if (!s.exists) return 'OK:0';

    var d = new Folder(String(dst).replace(/\\/g, '/'));
    if (!d.exists && !d.create()) return 'ERR:无法创建目标目录 ' + d.fsName;

    var list = s.getFiles();
    var n = 0;

    for (var i = 0; i < list.length; i++) {
      if (list[i] instanceof Folder) continue;

      var name = list[i].displayName || list[i].name;
      var target = new File(d.fsName + '/' + decodeURI(name));
      if (target.exists) target.remove();

      if (list[i].copy(target)) n++;
    }

    return 'OK:' + n;
  } catch (e) {
    return 'ERR:' + (e.message || e);
  }
}
