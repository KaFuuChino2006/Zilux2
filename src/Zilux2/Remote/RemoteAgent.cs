namespace Zilux2.Remote;

/// <summary>
/// 注入到播放器页面里的探针脚本（`window.__zxr`）。
///
/// 为什么需要它：宿主只给了页面一条命令白名单（togglePlay/prev/next/volumeUp/…），
/// 没有「播放第 N 首搜索结果」「跳到队列第 K 首」「把音量设成 42%」这类入口。页面自己
/// 的实现（trackRow 的 click → playQueue、upnext 行的 dblclick → playAt、播放条上的音量
/// 滑条 → setVolume）已经是最完整的状态机，所以这里只做**读取 DOM 状态 + 触发同一批控件**，
/// 不复制任何播放逻辑，也就不存在两套状态机打架的问题。
///
/// 与宿主的通道：`window.chrome.webview.postMessage({v:1,type:'remote',...})`（设置卡片用），
/// 反向的调用走 `CoreWebView2.ExecuteScriptAsync`（`__zxr.*` 同步返回 JSON 字符串），
/// 因此轮询不会在 host.log 里留下「unknown message type」噪音。
/// </summary>
internal static class RemoteAgent
{
    /// <summary>脚本版本：页面重载后 RemoteBridge 会重新注入，版本号只用于日志。</summary>
    internal const int Version = 1;

    internal const string Script = """
(function () {
  var VERSION = 1;
  var existing = window.__zxr;
  if (existing && existing.v === VERSION) { return 'kept'; }

  var q1 = function (sel, root) { return (root || document).querySelector(sel); };
  var qa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var txt = function (el) { return el ? (el.textContent || '').trim() : ''; };
  var clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };
  var post = function (payload) {
    try {
      if (window.chrome && window.chrome.webview) { window.chrome.webview.postMessage(payload); }
    } catch (err) { /* 浏览器预览里没有宿主通道 */ }
  };

  var A = { v: VERSION };

  function modeButton() {
    return q1('.playerbar .pb-mode[data-mode]') || q1('.pb-mode[data-mode]');
  }

  function volumeInput() {
    return q1('.volume-wrap input.slider[type=range]') || q1('.playerbar input.slider[type=range]');
  }

  function upnextRoot() {
    return q1('.upnext');
  }

  function searchInput() {
    return q1('.search-dock-input') || q1('input.search-dock-input');
  }

  function searchRows() {
    return qa('.search-list .row');
  }

  function rowInfo(row, index) {
    var img = q1('.row-cover img', row) || q1('img', row);
    return {
      i: index,
      title: txt(q1('.row-name', row)) || txt(row),
      artist: txt(q1('.row-artist', row)),
      source: txt(q1('.source-tag', row)),
      dur: txt(q1('.row-dur', row)),
      cover: img ? (img.getAttribute('src') || '') : ''
    };
  }

  function upnextRows() {
    var root = upnextRoot();
    if (!root) { return []; }
    return qa('.upnext-row', root).map(function (row) {
      return {
        i: Number(row.getAttribute('data-queue-index') || '-1'),
        title: txt(q1('.upnext-title', row)),
        artist: txt(q1('.upnext-artist', row))
      };
    });
  }

  // 播放条上的待播面板是懒渲染的：关着的时候 .upnext-row 不刷新。点一下摘要行（页面监听的是
  // click）让页面自己走 openUpNext() → renderUpNextList(true)，然后同步读回来。
  A.queue = function () {
    var root = upnextRoot();
    if (!root) { return { available: false, reason: 'no-player' }; }
    var items = upnextRows();
    if (!items.length) {
      var summary = q1('.upnext-summary', root);
      if (summary) {
        try {
          summary.click();
        } catch (err) { /* 面板不存在时忽略 */ }
        items = upnextRows();
      }
    }
    return { available: items.length > 0, items: items };
  };

  A.state = function () {
    var btn = modeButton();
    var vol = volumeInput();
    var muted = !!q1('.volume-icon.is-muted') || !!q1('.volume-wrap .is-muted');
    return {
      v: VERSION,
      hasPlayer: !!q1('.playerbar'),
      mode: btn ? (btn.getAttribute('data-mode') || '') : '',
      modeTitle: btn ? (btn.getAttribute('title') || '') : '',
      volume: vol ? clamp(Number(vol.value) || 0, 0, 100) : null,
      muted: muted
    };
  };

  A.volume = function (percent) {
    var vol = volumeInput();
    if (!vol) { return { ok: false, reason: 'no-slider' }; }
    var value = String(clamp(Math.round(Number(percent) || 0), 0, 100));
    vol.value = value;
    vol.dispatchEvent(new Event('input', { bubbles: true }));
    vol.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, volume: Number(value), muted: !!q1('.volume-icon.is-muted') };
  };

  // 播放模式只有「点一下切下一个」这一条路：按 pointerdown（页面就是监听这个事件），
  // 最多绕一圈，绕不回来就如实报告当前模式。
  A.mode = function (target) {
    var btn = modeButton();
    if (!btn) { return { ok: false, reason: 'no-button' }; }
    var current = btn.getAttribute('data-mode') || '';
    for (var attempt = 0; attempt < 4 && current !== target; attempt += 1) {
      try {
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
      } catch (err) {
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      }
      current = btn.getAttribute('data-mode') || '';
    }
    return { ok: current === target, mode: current };
  };

  A.jump = function (queueIndex) {
    var root = upnextRoot();
    if (!root) { return { ok: false, reason: 'no-player' }; }
    var items = upnextRows();
    if (!items.length) {
      // 行是懒渲染的：先让面板展开一次，再按 data-queue-index 找。
      A.queue();
      items = upnextRows();
    }
    if (!items.length) { return { ok: false, reason: 'no-queue' }; }
    var index = Number(queueIndex);
    var row = q1('.upnext-row[data-queue-index="' + index + '"]', root);
    if (!row) { return { ok: false, reason: 'row-missing' }; }
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  };

  // 边打边搜：写进搜索框 + 触发 input，页面自己的防抖/并发搜索会把结果渲染到 .search-list。
  // 这里只负责采样「结果是否稳定」，判定交给宿主轮询。
  A._search = { q: '', startedAt: 0, lastCount: -1, lastChangeAt: 0 };
  A.searchStart = function (text) {
    var input = searchInput();
    if (!input) { return { ok: false, reason: 'no-input' }; }
    var value = String(text || '').slice(0, 100);
    if (!value) { return { ok: false, reason: 'empty' }; }
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    A._search = { q: value, startedAt: Date.now(), lastCount: -1, lastChangeAt: Date.now() };
    return { ok: true, q: value };
  };

  A.searchPoll = function () {
    var s = A._search;
    if (!s || !s.q) { return { state: 'idle', rows: [] }; }
    var rows = searchRows().map(rowInfo);
    var note = txt(q1('.search-list .search-note') || q1('.search-note'));
    var now = Date.now();
    if (rows.length !== s.lastCount) {
      s.lastCount = rows.length;
      s.lastChangeAt = now;
    }
    var quiet = now - s.lastChangeAt > 550;
    var busy = note.indexOf('搜索中') >= 0 || note.indexOf('加载中') >= 0;
    var state = rows.length > 0 && quiet && !busy ? 'done' : 'pending';
    if (state === 'pending' && now - s.startedAt > 9000) { state = 'timeout'; }
    if (state === 'pending' && rows.length === 0 && quiet && now - s.startedAt > 3000) { state = 'empty'; }
    return { state: state, q: s.q, note: note, rows: rows };
  };

  // 点一首搜索结果：按歌名+歌手找回当前列表里的那一行（列表可能已经重渲染，索引不可靠），
  // 然后触发页面自己的 click → playQueue(queue, index, true)。
  A.play = function (title, artist) {
    var rows = searchRows();
    if (!rows.length) { return { ok: false, reason: 'no-results' }; }
    var wantTitle = String(title || '').trim();
    var wantArtist = String(artist || '').trim();
    var pick = null;
    for (var i = 0; i < rows.length; i += 1) {
      var info = rowInfo(rows[i], i);
      if (info.title === wantTitle && (!wantArtist || info.artist === wantArtist)) { pick = rows[i]; break; }
    }
    if (!pick && wantTitle) {
      for (var j = 0; j < rows.length; j += 1) {
        var loose = rowInfo(rows[j], j);
        if (loose.title === wantTitle) { pick = rows[j]; break; }
      }
    }
    if (!pick) { return { ok: false, reason: 'row-missing' }; }
    pick.click();
    return { ok: true };
  };

  /* ------------------------------------------------------------------ */
  /* 设置页里的「手机遥控」卡片                                            */
  /* ------------------------------------------------------------------ */

  var card = { root: null, refs: null };

  function activePane() {
    var panes = qa('.settings-pane');
    for (var i = 0; i < panes.length; i += 1) {
      var pane = panes[i];
      if (pane.offsetParent !== null && pane.getBoundingClientRect().height > 0) { return pane; }
    }
    return panes.length ? panes[panes.length - 1] : null;
  }

  function copyText(value) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () { post({ v: 1, type: 'remote', op: 'copied', ok: true }); },
          function () { post({ v: 1, type: 'remote', op: 'copied', ok: false }); });
        return;
      }
    } catch (err) { /* fall through */ }
    var area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(area);
    post({ v: 1, type: 'remote', op: 'copied', ok: ok });
  }

  function buildCard(payload) {
    var root = document.createElement('div');
    root.className = 'zxr-card';
    root.id = 'zxr-remote-card';
    root.setAttribute('data-zxr', '1');
    root.style.cssText = 'margin:18px 4px 8px;padding:16px 18px;border-radius:14px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.035)';

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px';
    var title = document.createElement('div');
    title.className = 'field-label';
    title.textContent = '手机遥控';
    title.style.cssText = 'font-weight:700;font-size:14px';
    var sw = document.createElement('button');
    sw.type = 'button';
    // 复用主程序的 .switch（app.css 里有 46x26 尺寸、:after 圆点、.is-on 的渐变与位移），
    // 自绘会跟其它设置行的开关长得不一样；同时给稳定 id，方便页面/自动化定位。
    sw.id = 'zxr-remote-switch';
    sw.className = 'switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', '手机遥控开关');
    sw.style.cssText = 'border:0;padding:0;cursor:pointer;flex:0 0 auto';
    head.appendChild(title);
    head.appendChild(sw);

    var note = document.createElement('div');
    note.id = 'zxr-remote-note';
    note.className = 'set-note';
    note.style.cssText = 'font-size:12px;line-height:1.6;opacity:.72;margin:0 0 10px';

    var linkRow = document.createElement('div');
    linkRow.style.cssText = 'display:flex;gap:8px;align-items:stretch;flex-wrap:wrap';
    var link = document.createElement('div');
    link.id = 'zxr-remote-link';
    link.style.cssText = 'flex:1 1 240px;min-width:0;font:600 13px/1.5 ui-monospace,Consolas,monospace;word-break:break-all;padding:9px 11px;border-radius:10px;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.08)';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'pill';
    copy.textContent = '复制链接';
    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'pill';
    open.textContent = '本机预览';
    linkRow.appendChild(link);
    linkRow.appendChild(copy);
    linkRow.appendChild(open);

    var row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px';
    var portLabel = document.createElement('span');
    portLabel.className = 'set-value';
    portLabel.textContent = '端口';
    var portInput = document.createElement('input');
    portInput.id = 'zxr-remote-port';
    portInput.type = 'number';
    portInput.min = '0';
    portInput.max = '65535';
    portInput.className = 'set-number';
    portInput.style.cssText = 'width:96px;padding:7px 9px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.25);color:inherit';
    var apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'pill';
    apply.textContent = '应用端口';
    row2.appendChild(portLabel);
    row2.appendChild(portInput);
    row2.appendChild(apply);

    var status = document.createElement('div');
    status.id = 'zxr-remote-status';
    status.className = 'set-note';
    status.style.cssText = 'font-size:12px;margin-top:10px;opacity:.72';

    root.appendChild(head);
    root.appendChild(note);
    root.appendChild(linkRow);
    root.appendChild(row2);
    root.appendChild(status);

    sw.addEventListener('click', function () {
      post({ v: 1, type: 'remote', op: 'setEnabled', value: sw.dataset.on !== '1' });
    });
    copy.addEventListener('click', function () { copyText(link.textContent || ''); });
    open.addEventListener('click', function () {
      var url = link.textContent || '';
      if (url) { post({ v: 1, type: 'remote', op: 'openUrl', value: url }); }
    });
    apply.addEventListener('click', function () {
      post({ v: 1, type: 'remote', op: 'setPort', value: Number(portInput.value) || 0 });
    });

    card.refs = { root: root, sw: sw, note: note, link: link, port: portInput, status: status };
    return root;
  }

  A.cardUpdate = function (payload) {
    var refs = card.refs;
    if (!refs) { return 'no-card'; }
    var enabled = !!payload.enabled;
    refs.sw.classList.toggle('is-on', enabled);
    refs.sw.dataset.on = enabled ? '1' : '0';
    refs.sw.setAttribute('aria-checked', enabled ? 'true' : 'false');
    refs.link.textContent = payload.url || '（未开启）';
    refs.link.style.opacity = payload.url ? '1' : '.45';
    refs.note.textContent = payload.note || '';
    if (document.activeElement !== refs.port) { refs.port.value = String(payload.port || 0); }
    refs.status.textContent = payload.status || '';
    return 'ok';
  };

  // 设置页是每次打开重建的：每 800ms 检查一次，卡片不在页面上就挂回去。
  // 只挂「通用」那一页 —— 之前挂在 .settings-content（所有 tab 共用的容器）上，
  // 结果每一页底部都能看到这张卡；手机遥控本来就属于通用设置。
  // 手机遥控属于「通用」设置：用该页独有文案判定（启动时最大化 / 开机自启 / 自启动时不显示窗口）。
  // 通用页内部还有「启动 / 桌面歌词 / 系统」三个子 tab，卡片要再收窄到「系统」那一栏：
  // 只看子 tab 的选中态，不再用正文文案判定（正文在三栏里都还在 DOM 里）。
  function isRemoteHostPane(pane) {
    if (!pane) { return false; }
    var onTab = pane.querySelector('.settings-subtab.is-on');
    if (!onTab) { return false; }
    return (onTab.textContent || '').trim() === '系统';
  }

  function ensureCard() {
    var pane = activePane();
    var host = isRemoteHostPane(pane) ? pane : null;
    if (!host) {
      // 当前不是动态壁纸页：把卡片摘掉，避免它跟着出现在别的设置页里。
      var stale = q1('[data-zxr="1"]');
      if (stale && stale.parentNode) { stale.parentNode.removeChild(stale); }
      return;
    }

    var nodes = document.querySelectorAll('[data-zxr="1"]');
    for (var i = 1; i < nodes.length; i++) { nodes[i].parentNode.removeChild(nodes[i]); }

    if (!card.refs) {
      var placeholder = buildCard({});
      card.refs.root = placeholder;
    }

    var root = card.refs.root;
    if (root.parentNode === host) { return; }
    if (root.parentNode) { root.parentNode.removeChild(root); }
    host.appendChild(root);
    post({ v: 1, type: 'remote', op: 'cardMounted' });
  }

  if (!A._cardTimer) {
    A._cardTimer = window.setInterval(function () {
      try { ensureCard(); } catch (err) { /* 设置页还没建好 */ }
    }, 800);
  }

  window.__zxr = A;
  return 'installed';
})()
""";
}
