/**
 * tasks.js — 异步任务登记与断点续取
 *
 * 背景：以前出图是一个 40-60 秒的长请求。面板一收起（»），CEP 冻结页面、
 * 掐断 fetch，面板只收到 "Failed to fetch"，而服务端照跑照扣费 ——
 * 钱花了，图没了。
 *
 * 现在改成「提交即返回 + 轮询」：提交只花 0.5 秒拿一个 task_id，
 * 之后每个轮询请求都是几百毫秒的短请求，被掐断也没关系，下一轮接着问。
 *
 * 本模块负责：
 *   1. 提交成功后**同步**把任务写进 localStorage（同步写才扛得住崩溃/强杀），
 *      记下它属于哪个会话、哪条消息，方便回来时把结果塞回原位；
 *   2. 面板每次启动时 resume()，把没跑完的任务接着轮询，跑完自动写回那一轮对话；
 *   3. 提供按 ID 手动取回（任务 ID 可以在中转站后台抄到）。
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util;
  var LS_KEY = 'hh_tasks_v1';
  var POLL_MS = 6000;
  var MAX_MS = 15 * 60 * 1000;

  var list = [];

  /* ---------------- 存储 ---------------- */

  function load() {
    var raw = '';
    try { raw = localStorage.getItem(LS_KEY) || '[]'; } catch (e) { raw = '[]'; }
    try { list = JSON.parse(raw) || []; } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    return list;
  }

  /** 同步写入：崩溃、强杀进程也不会丢 */
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch (e) { /* 配额满就算了 */ }
  }

  function add(rec) {
    load();
    // 同一条消息重复提交时覆盖旧记录
    list = list.filter(function (t) { return !(t.page === rec.page && t.msgId === rec.msgId); });
    rec.createdAt = rec.createdAt || Date.now();
    list.push(rec);
    // 最多留 50 条，避免老任务无限堆积
    if (list.length > 50) list = list.slice(-50);
    save();
    return rec;
  }

  function remove(taskId) {
    load();
    list = list.filter(function (t) { return t.taskId !== taskId; });
    save();
  }

  function find(taskId) {
    load();
    for (var i = 0; i < list.length; i++) if (list[i].taskId === taskId) return list[i];
    return null;
  }

  function pending() {
    load();
    return list.slice();
  }

  /* ---------------- 派发 ---------------- */

  function pageOf(rec) {
    var p = HH.pages || {};
    return rec.page === 'generate' ? p.generate : p.edit;
  }

  /** 轮询进度 -> 对应页面（页面自己决定怎么显示） */
  function report(rec, status, progress) {
    var pg = pageOf(rec);
    if (pg && pg.onTaskProgress) {
      try { pg.onTaskProgress(rec, status, progress); } catch (e) { /* 页面没挂载就算了 */ }
    }
  }

  /** 任务完成 -> 把图塞回原来那一轮对话 */
  function dispatch(rec, items) {
    var pg = pageOf(rec);
    if (pg && pg.applyTaskResult) {
      try { pg.applyTaskResult(rec, items); } catch (e) { console.warn('[tasks] 写回失败', e); }
      return true;
    }
    return false;
  }

  /* ---------------- 轮询 ---------------- */

  /**
   * 盯着一个任务直到出结果
   * @param {object} rec 任务记录
   * @param {object} cb { onProgress(st, pg), onDone(items, rec), onFail(msg, rec) }
   */
  function follow(rec, cb) {
    cb = cb || {};
    var t0 = Date.now();
    var failRun = 0;              // 连续查询失败次数，成功一次就清零

    function step() {
      if (!HH.api || !HH.api.pollTask) { if (cb.onFail) cb.onFail('API 模块未就绪', rec); return; }

      if (Date.now() - t0 > MAX_MS) {
        if (cb.onFail) cb.onFail('等待超过 15 分钟仍未完成', rec);
        return;
      }

      HH.api.pollTask(rec.taskId).then(function (st) {
        failRun = 0;
        if (cb.onProgress) cb.onProgress(st.status, st.progress);
        report(rec, st.status, st.progress);

        if (st.failed) {
          if (cb.onFail) cb.onFail(st.error || '任务失败', rec);
          return;
        }
        if (st.done) {
          Promise.all(st.urls.map(function (u) {
            return HH.api.urlToDataUrl(u).catch(function () { return u; });
          })).then(function (items) {
            if (cb.onDone) cb.onDone(items, rec);
          });
          return;
        }
        setTimeout(step, POLL_MS);
      }).catch(function (err) {
        // 面板被收起时轮询会失败 —— 这不要紧，任务还在服务端，下一轮接着问。
        // 但不能问得太勤：服务端真在 5xx 时，6 秒一次能连问 150 次，纯属添乱。
        failRun++;
        setTimeout(step, U.pollBackoff(failRun));
      });
    }

    setTimeout(step, 600);
  }

  /** 任务完成后统一收尾：写回那一轮对话 + 出名单 + 提示 */
  function settle(rec, items, toastText) {
    dispatch(rec, items);
    remove(rec.taskId);
    if (HH.ui) {
      HH.ui.toast(toastText || ('已取回任务（' + String(rec.taskId).slice(-6) + '）'), 'ok');
    }
  }

  /**
   * 面板启动时调用：把没跑完的任务接上
   * @returns {number} 接上的任务数
   */
  function resume() {
    var arr = pending();
    if (!arr.length) return 0;
    if (!HH.api || !HH.api.isConfigured || !HH.api.isConfigured()) return 0;

    arr.forEach(function (rec) { follow(rec, defaultHandlers(rec)); });

    return arr.length;
  }

  /** resume / takeOver 共用的回调：finish 时写回，fail 时留在列表里等手动处理 */
  function defaultHandlers(rec) {
    return {
      onDone: function (items) {
        settle(rec, items, '已取回之前中断的任务（' + String(rec.taskId).slice(-6) + '）');
      },
      onFail: function (msg) {
        // 失败的任务留在列表里，让用户能在「我的」里看到并手动处理
        if (/不存在|not_exist/i.test(msg)) remove(rec.taskId);
        var pg = pageOf(rec);
        if (pg && pg.onTaskFail) { try { pg.onTaskFail(rec, msg); } catch (e) {} }
      }
    };
  }

  /**
   * 前台轮询判死后，后台立刻接上这个任务
   *
   * 以前只有面板启动时才会 resume()，所以前台一失败，同一个会话里就没人再问
   * 这个任务了。api.js 在判死的同一时刻调这里，出图了照样自动写回那一轮对话。
   *
   * @returns {boolean} 接管成功与否（任务已被手动取回/移除时返回 false）
   */
  function takeOver(taskId) {
    taskId = String(taskId || '').trim();
    if (!taskId) return false;
    if (!HH.api || !HH.api.pollTask) return false;

    var rec = find(taskId);
    if (!rec) return false;          // 已经不在名单里了，别重复盯

    follow(rec, defaultHandlers(rec));
    return true;
  }

  /**
   * 按 ID 手动取回一次（任务 ID 可以从中转站后台抄）
   * @returns {Promise<{ok:boolean, items:string[], status:string, message:string}>}
   */
  function fetchNow(taskId) {
    taskId = String(taskId || '').trim();
    if (!taskId) return Promise.resolve({ ok: false, items: [], status: '', message: '请填写任务 ID' });
    if (!HH.api || !HH.api.pollTask) return Promise.resolve({ ok: false, items: [], status: '', message: 'API 模块未就绪' });

    return HH.api.pollTask(taskId).then(function (st) {
      if (st.failed) {
        return { ok: false, items: [], status: st.status, message: st.error || '任务失败' };
      }
      if (!st.done) {
        return { ok: false, items: [], status: st.status, message: '任务还没完成（' + (st.status || '进行中') + (st.progress ? ' ' + st.progress : '') + '），晚点再试' };
      }
      return Promise.all(st.urls.map(function (u) {
        return HH.api.urlToDataUrl(u).catch(function () { return u; });
      })).then(function (items) {
        return { ok: true, items: items, status: st.status, message: '取回 ' + items.length + ' 张' };
      });
    }).catch(function (err) {
      return { ok: false, items: [], status: '', message: (err && err.message) || '查询失败' };
    });
  }

  HH.tasks = {
    load: load,
    add: add,
    remove: remove,
    find: find,
    pending: pending,
    follow: follow,
    resume: resume,
    takeOver: takeOver,
    fetchNow: fetchNow,
    dispatch: dispatch
  };

})(window);
