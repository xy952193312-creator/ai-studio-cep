/**
 * CSInterface.js — 精简版 CEP 宿主接口垫片
 *
 * 官方 CSInterface.js 有 1000+ 行，本项目只需 evalScript / 系统路径 / 事件，
 * 这里按 CEP 运行时真实 API（window.__adobe_cep__）重写一个等价子集，
 * 避免直接拷贝官方库带来的体积与版本耦合。
 *
 * 若将来放入官方完整版 CSInterface.js，本文件会自动让路（检测到已存在则跳过）。
 */
(function (global) {
  'use strict';

  if (typeof global.CSInterface === 'function') return; // 已有官方版，不覆盖

  var cep = global.__adobe_cep__ || null;

  /** 系统路径常量，与官方保持一致 */
  var SystemPath = {
    USER_DATA: 'userData',
    COMMON_FILES: 'commonFiles',
    MY_DOCUMENTS: 'myDocuments',
    APPLICATION: 'application',
    EXTENSION: 'extension',
    HOST_APPLICATION: 'hostApplication'
  };

  function CSInterface() {}

  /**
   * CEP 12 的 getSystemPath 返回的是 file:/// URL（官方库会转成磁盘路径），
   * 部分老版本直接返回路径。这里统一成操作系统路径，两种都兼容。
   */
  function toOsPath(u) {
    var s = String(u == null ? '' : u);
    if (!/^file:\/\//i.test(s)) return s;

    s = s.replace(/^file:\/\//i, '');
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);   // Windows: /C:/... -> C:/...
    try { s = decodeURIComponent(s); } catch (e) { /* 保留原样 */ }
    return s;
  }

  /** 执行宿主 ExtendScript，回调签名 callback(resultString) */
  CSInterface.prototype.evalScript = function (script, callback) {
    if (!cep || typeof cep.evalScript !== 'function') {
      // 与官方行为一致：失败也走回调，避免调用方静默卡死
      if (typeof callback === 'function') callback('EvalScript error.');
      return;
    }
    cep.evalScript(String(script == null ? '' : script), function (res) {
      if (typeof callback === 'function') callback(res);
    });
  };

  CSInterface.prototype.getSystemPath = function (pathType) {
    if (!cep || typeof cep.getSystemPath !== 'function') return '';
    return toOsPath(cep.getSystemPath(pathType) || '');
  };

  /** 返回解析后的对象（官方版返回 Object，不是字符串） */
  CSInterface.prototype.getHostEnvironment = function () {
    try {
      return JSON.parse(cep.getHostEnvironment());
    } catch (e) {
      return {};
    }
  };

  CSInterface.prototype.getOSInformation = function () {
    try {
      return cep.getOSInformation();
    } catch (e) {
      return '';
    }
  };

  CSInterface.prototype.getExtensionID = function () {
    try {
      return cep.getExtensionId();
    } catch (e) {
      return '';
    }
  };

  CSInterface.prototype.addEventListener = function (type, listener, obj) {
    try {
      cep.addEventListener(type, listener, obj);
    } catch (e) {
      console.warn('[CSInterface] addEventListener 失败', type, e);
    }
  };

  CSInterface.prototype.removeEventListener = function (type, listener, obj) {
    try {
      cep.removeEventListener(type, listener, obj);
    } catch (e) {
      console.warn('[CSInterface] removeEventListener 失败', type, e);
    }
  };

  /** 打开扩展自身的 URL（调试或跳转用） */
  CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    try {
      cep.openURLInDefaultBrowser(url);
    } catch (e) { /* 忽略 */ }
  };

  CSInterface.prototype.getExtensionPath = function () {
    return this.getSystemPath(SystemPath.EXTENSION);
  };

  CSInterface.SystemPath = SystemPath;
  CSInterface.ThemeColor = {
    DARKEST: 'darkest',
    DARK: 'dark',
    LIGHT: 'light',
    LIGHTEST: 'lightest'
  };

  global.CSInterface = CSInterface;
})(window);
