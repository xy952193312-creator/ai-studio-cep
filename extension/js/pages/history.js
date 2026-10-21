/**
 * pages/history.js — 历史记录页
 *
 * 两个视图：
 *   图片记录  每张生成结果一条，可预览 / 下载 / 删除，双击回到它所在的对话
 *   对话记录  每段对话一条（多轮），双击或点「打开对话」把整段对话捞回智能改图页
 *
 * 双击图片 = 回到生成它的那段对话（结果图、参考图、提示词全部原样保留，
 * 仍可继续插入图层 / 预览 / 下载 / 再次生成）
 */
(function (global) {
  'use strict';

  var HH = global.HH = global.HH || {};
  var U = HH.util, S = HH.store, UI = HH.ui;

  HH.pages = HH.pages || {};

  var FILTERS = [
    { key: 'all', name: '全部' },
    { key: 'edit', name: '智能改图' },
    { key: 'generate', name: 'AI生图' }
  ];

  /* ---------------- 数据 ---------------- */
  function filtered() {
    var f = S.state.ui.historyFilter;
    return S.state.history.filter(function (e) {
      return f === 'all' ? true : e.page === f;
    });
  }

  function currentView() {
    return S.state.ui.historyView === 'sessions' ? 'sessions' : 'images';
  }

  /* ---------------- 图片记录 ---------------- */
  /** 这条记录还找不找得到原图（老版本存过 full=缩略图 的记录找不回来） */
  function hasFullImage(e) {
    if (!e) return false;
    if (e.file) return true;
    return !!(e.full && e.full !== e.thumb);
  }

  function cardHTML(e) {
    var kindName = e.page === 'edit' ? '智能改图' : 'AI生图';
    var canOpen = e.page === 'edit';

    return '' +
    '<div class="hist-card" data-id="' + U.escapeHTML(e.id) + '"' +
      (canOpen ? ' title="双击打开这段对话"' : '') + '>' +
      '<div class="hist-thumb" data-act="preview" title="点击预览">' +
        '<img ' + U.lazyImg(e.thumb || e.thumbFile || e.file) + ' alt="">' +
        '<span class="hist-kind">' + kindName + '</span>' +
        (canOpen ? '<span class="hist-chat">对话</span>' : '') +
      '</div>' +
      '<div class="hist-body">' +
        '<div class="hist-prompt" title="' + U.escapeHTML(e.prompt || '') + '">' +
          U.escapeHTML(e.prompt || '（无提示词）') + '</div>' +
        '<div class="hist-meta">' +
          '<span>' + U.escapeHTML(U.fmtTime(e.createdAt)) + '</span>' +
          '<span class="dot"></span>' +
          '<span title="' + U.escapeHTML(e.model || '') + '">' +
            U.escapeHTML(e.model || '未指定模型') + '</span>' +
          (e.size ? '<span class="dot"></span><span>' + U.escapeHTML(e.size) + '</span>' : '') +
          (hasFullImage(e) ? '' :
            '<span class="dot"></span><span class="hist-warn" ' +
            'title="这条记录生成于旧版本，当时只保存了 360px 缩略图，原图已无法找回">仅缩略图</span>') +
        '</div>' +
        '<div class="hist-actions">' +
          (canOpen ? '<button class="btn btn-primary-sm" data-act="openChat">打开对话</button>' : '') +
          '<button class="btn" data-act="reedit">重新编辑</button>' +
          '<button class="btn" data-act="download">下载</button>' +
          '<button class="btn btn-danger" data-act="del">删除</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ---------------- 对话记录 ---------------- */
  function sessCardHTML(s) {
    var st = S.sessionStats(s);
    var cover = S.sessionCover(s);

    return '' +
    '<div class="hist-card" data-sid="' + U.escapeHTML(s.id) + '" title="双击打开这段对话">' +
      '<div class="hist-thumb" data-act="openSess">' +
        (cover
          ? '<img ' + U.lazyImg(cover) + ' alt="">'
          : '<div class="hist-thumb-empty">无图</div>') +
        '<span class="hist-kind">对话</span>' +
      '</div>' +
      '<div class="hist-body">' +
        '<div class="hist-prompt" title="' + U.escapeHTML(S.sessionTitle(s)) + '">' +
          U.escapeHTML(S.sessionTitle(s)) + '</div>' +
        '<div class="hist-meta">' +
          '<span>' + st.rounds + ' 轮 · ' + st.images + ' 张图</span>' +
          '<span class="dot"></span>' +
          '<span>' + U.escapeHTML(U.fmtAgo(s.updatedAt)) + '</span>' +
          (s.model ? '<span class="dot"></span><span>' + U.escapeHTML(s.model) + '</span>' : '') +
        '</div>' +
        '<div class="hist-actions">' +
          '<button class="btn btn-primary-sm" data-act="openSess">打开对话</button>' +
          '<button class="btn btn-danger" data-act="delSess">删除</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function listHTML() {
    if (currentView() === 'sessions') {
      var list = S.activeSessions();
      if (!list.length) {
        return UI.empty('暂无对话记录', '在「智能改图」里聊天，每段对话都会自动存档');
      }
      return list.map(sessCardHTML).join('');
    }

    var items = filtered();
    if (!items.length) {
      return UI.empty('暂无图片记录', '生成的图片会自动保存在本机，最多 ' + S.MAX_HISTORY + ' 条');
    }
    return items.map(cardHTML).join('');
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var view = currentView();
    var total = S.state.history.length;
    var sessTotal = S.activeSessions().length;
    var sub = view === 'sessions'
      ? '本地保存 · 共 ' + sessTotal + ' 段对话'
      : '本地保存 · 共 ' + total + ' 条';

    return '' +
    '<div class="page" id="histPage">' +
      '<div class="page-head">' +
        '<div>' +
          '<div class="page-title">历史记录</div>' +
          '<div class="page-sub">' + sub + '</div>' +
        '</div>' +
        '<div class="page-head-actions">' +
          (total ? '<button class="btn btn-sm btn-ghost" data-act="clearAll">清空</button>' : '') +
        '</div>' +
      '</div>' +

      '<div class="seg" id="histSeg">' +
        '<span class="seg-item' + (view === 'images' ? ' is-active' : '') +
          '" data-view="images">图片记录</span>' +
        '<span class="seg-item' + (view === 'sessions' ? ' is-active' : '') +
          '" data-view="sessions">对话记录</span>' +
      '</div>' +

      (view === 'images'
        ? '<div class="history-bar">' +
            '<div class="chips">' +
              FILTERS.map(function (it) {
                return '<span class="chip' + (it.key === S.state.ui.historyFilter ? ' is-active' : '') +
                  '" data-filter="' + it.key + '">' + it.name + '</span>';
              }).join('') +
            '</div>' +
          '</div>'
        : '<div class="history-bar"><div class="hist-tip">双击对话即可重新打开，生成结果仍可查看</div></div>') +

      '<div class="history-list" id="histList">' + listHTML() + '</div>' +
    '</div>';
  }

  /* ---------------- 打开对话 ---------------- */
  /** 从某张图片记录回到它的对话 */
  function openFromImage(id) {
    var entry = S.findHistory(id);
    if (!entry) return;

    // AI 生图不是对话流，双击就按预览处理
    if (entry.page !== 'edit') {
      HH.ps.imageInfo(entry).then(function (info) {
        if (!info || !info.url) { UI.toast('图片数据已丢失', 'error'); return; }
        var tip = U.fmtTime(entry.createdAt) + ' · ' + (entry.model || '');
        // 只残存缩略图的老记录，预览时说清楚，别让人以为是原图
        if (info.lowRes) tip += ' · 仅存缩略图 ' + info.w + '×' + info.h;
        UI.preview(info.url, tip, { w: info.w, h: info.h });
      });
      return;
    }

    var sessId = entry.sessionId && S.findSession(entry.sessionId) ? entry.sessionId : '';
    if (!sessId) {
      // 升级前的老记录：按图片反推一段单轮对话
      var legacy = S.buildLegacySession(entry);
      sessId = legacy ? legacy.id : '';
    }
    if (!sessId) { UI.toast('这条记录缺少对话信息', 'error'); return; }

    S.openSession(sessId).then(function (sess) {
      if (!sess) { UI.toast('正在生成中，稍后再切换对话', 'error'); return; }
      S.setIntent({ page: 'edit', sessionId: sessId, focusResult: id });
      location.hash = '#/edit';
    });
  }

  function openSessionById(sid) {
    var sess = S.findSession(sid);
    if (!sess) { UI.toast('对话已不存在', 'error'); HH.app.refresh(); return; }

    S.openSession(sid).then(function (ok) {
      if (!ok) {
        UI.toast('正在生成中，稍后再切换对话', 'error');
        return;
      }
      S.setIntent({ page: 'edit', sessionId: sid });
      location.hash = '#/edit';
    });
  }

  /* ---------------- 绑定 ---------------- */
  function bind(root) {
    var list = U.$('#histList');
    if (!list) return;

    /* 单击预览要等 200ms：否则双击时第一下就把预览遮罩打开了，双击永远落不到卡片上 */
    var clickTimer = null;
    function later(fn) {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(function () { clickTimer = null; fn(); }, 200);
    }

    /* 视图切换：图片记录 / 对话记录 */
    root.addEventListener('click', function (e) {
      var seg = e.target.closest('[data-view]');
      if (seg) {
        S.state.ui.historyView = seg.getAttribute('data-view');
        S.saveUi();
        HH.app.refresh();
        return;
      }

      var chip = e.target.closest('[data-filter]');
      if (chip) {
        S.state.ui.historyFilter = chip.getAttribute('data-filter');
        S.saveUi();
        HH.app.refresh();
      }
    });

    /* 卡片按钮 */
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;

      var card = btn.closest('.hist-card');
      if (!card) return;

      var act = btn.getAttribute('data-act');

      /* ----- 对话记录 ----- */
      if (card.hasAttribute('data-sid')) {
        var sid = card.getAttribute('data-sid');

        if (act === 'openSess') { openSessionById(sid); return; }

        if (act === 'delSess') {
          var sess = S.findSession(sid);
          var st = S.sessionStats(sess);
          UI.confirm('删除这段对话？', '共 ' + st.rounds + ' 轮、' + st.images + ' 张图，删除后无法恢复（已下载的文件不受影响）。')
            .then(function (ok) {
              if (!ok) return;
              S.removeSession(sid);
              UI.toast('已删除对话', 'ok');
              HH.app.refresh();
            });
        }
        return;
      }

      /* ----- 图片记录 ----- */
      var id = card.getAttribute('data-id');
      var entry = S.findHistory(id);
      if (!entry) return;

      if (act === 'preview') {
        var snap = entry;
        later(function () {
          // 原图在磁盘缓存里，先读回来再开灯箱
          HH.ps.imageInfo(snap).then(function (info) {
            if (!info || !info.url) { UI.toast('图片数据已丢失', 'error'); return; }
            var tip = U.fmtTime(snap.createdAt) + ' · ' + (snap.model || '');
            if (info.lowRes) tip += ' · 仅存缩略图 ' + info.w + '×' + info.h;
            UI.preview(info.url, tip, { w: info.w, h: info.h });
          });
        });
      } else if (act === 'openChat') {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        openFromImage(id);
      } else if (act === 'download') {
        HH.ps.imageInfo(entry).then(function (info) {
          if (!info || !info.url) { UI.toast('找不到这张图', 'error'); return; }
          U.download(info.url, '历史_' + U.safeName(entry.prompt, 'image') + '_' + id.slice(-4) + '.png');
          if (info.lowRes) {
            UI.toast('下载的仍是 ' + info.w + '×' + info.h + ' 缩略图（原图未留存）', 'warn', 5000);
          }
        });
      } else if (act === 'reedit') {
        if (entry.page === 'edit') {
          S.setIntent({
            page: 'edit',
            prompt: entry.prompt || '',
            model: entry.model || '',
            images: entry.srcThumb
              ? [{ id: U.uid('img'), dataUrl: entry.srcThumb, name: 'history_ref' }]
              : []
          });
          location.hash = '#/edit';
        } else {
          S.setIntent({ page: 'generate', prompt: entry.prompt || '', model: entry.model || '', images: [] });
          location.hash = '#/generate';
        }
      } else if (act === 'del') {
        UI.confirm('删除这条记录？', '仅从本机 localStorage 中移除；它所在的对话记录仍可打开（图片可能只剩缩略图）。')
          .then(function (ok) {
            if (!ok) return;
            S.removeHistory(id);
            UI.toast('已删除', 'ok');
            HH.app.refresh();
          });
      }
    });

    /* 双击 = 打开整段对话 */
    list.addEventListener('dblclick', function (e) {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      if (e.target.closest('button')) return;

      var card = e.target.closest('.hist-card');
      if (!card) return;

      if (card.hasAttribute('data-sid')) openSessionById(card.getAttribute('data-sid'));
      else openFromImage(card.getAttribute('data-id'));
    });

    /* 清空全部 */
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="clearAll"]');
      if (!btn) return;
      UI.confirm('清空全部历史？', '共 ' + S.state.history.length + ' 条图片记录将被移出本机存储，操作不可撤销。')
        .then(function (ok) {
          if (!ok) return;
          S.clearHistory();
          UI.toast('已清空', 'ok');
          HH.app.refresh();
        });
    });
  }

  HH.pages.history = { render: render, bind: bind };

})(window);
