/**
 * task-6 验收步骤（Windows + Electron 联调，真引擎）。
 * 证据：每步返回值写进 report.json；关键节点截图；console/异常由 cdp-run 收集；
 * 宿主侧日志（[online] host ready port= / [media]）由 cdp-run 收集 shellOutput。
 */

export default [
  {
    name: 'boot',
    js: `
      await window.__t.waitFor(() => window.chrome && window.chrome.webview, 15000);
      const recent = await window.__t.waitForSelector('.recent-item', 20000);
      const webview = !!window.chrome?.webview?.postMessage;
      const apiResources = performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((name) => name.includes('/api/'));
      const origins = new Set(apiResources.map((name) => new URL(name).origin));
      return {
        origin: location.origin,
        isLocalEngine: /^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(location.origin),
        webview,
        homeLoaded: !!recent,
        apiRequestCount: apiResources.length,
        apiOrigins: [...origins],
        recentItems: window.__t.all('.recent-item').length,
        title: document.title,
        readyState: document.readyState,
      };
    `,
    waitMs: 1500,
    shot: true,
  },
  {
    name: 'home-rendered',
    js: `
      const firstRecent = document.querySelector('.recent-item');
      return {
        recentItems: window.__t.all('.recent-item').length,
        railButtons: window.__t.all('.rail-btn').map((el) => (el.getAttribute('aria-label') || '')).filter(Boolean),
        topbar: !!document.querySelector('.topbar'),
        playerbar: !!document.querySelector('.playerbar'),
        airplayVisible: window.__t.all('.rail-btn').filter((el) => (el.getAttribute('aria-label') || '') === '投送' && window.__t.visible(el)).length,
        airplayAnywhereVisible: window.__t.all('button, [role="button"]').filter((el) => {
          const label = (el.textContent || '').trim();
          return (label === '投送' || (el.getAttribute('aria-label') || '') === '投送') && window.__t.visible(el);
        }).length,
        firstRecentText: firstRecent ? (firstRecent.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : null,
        winBtnCount: window.__t.all('.win-btn').length,
      };
    `,
  },
  {
    name: 'airplay-hidden-dynamic',
    js: `
      // AirPlay 入口在快捷设置 / 设置页里是动态渲染的，注入脚本用 MutationObserver 隐藏，这里验证。
      const quickTrigger = document.querySelector('.pb-quick');
      if (quickTrigger) window.__t.tap(quickTrigger);
      await window.__t.waitFor(() => document.querySelector('.quick.is-open'), 5000);
      await window.__t.sleep(500);
      const quickTabs = window.__t.all('.quick-tabs button, .quick-tabs .quick-tab');
      const quickAirplay = quickTabs.filter((el) => (el.textContent || '').trim() === '投送');
      const quickAirplayVisible = quickAirplay.filter((el) => window.__t.visible(el)).length;
      if (quickTrigger) window.__t.tap(quickTrigger);
      await window.__t.sleep(400);
      const railSettings = window.__t.byAria('设置');
      if (railSettings) window.__t.tap(railSettings);
      await window.__t.sleep(900);
      const settingsAirplay = window.__t.all('button, [role="button"], [role="tab"]')
        .filter((el) => (el.textContent || '').trim() === '投送');
      const settingsAirplayVisible = settingsAirplay.filter((el) => window.__t.visible(el)).length;
      // 关掉设置面板（.sheet-head .icon-btn[title="关闭"]），否则会挡住后面的歌词/房间截图。
      const sheetClose = document.querySelector('.sheet .sheet-head .icon-btn[title="关闭"]');
      if (sheetClose) window.__t.tap(sheetClose);
      await window.__t.sleep(500);
      const sheetOpen = !!document.querySelector('.sheet');
      const railHome = window.__t.byAria('首页');
      if (railHome) window.__t.tap(railHome);
      await window.__t.sleep(600);
      return {
        quickTabs: quickTabs.map((el) => (el.textContent || '').trim()),
        quickAirplayCount: quickAirplay.length,
        quickAirplayVisible,
        settingsAirplayCount: settingsAirplay.length,
        settingsAirplayVisible,
        settingsSheetClosed: !sheetOpen,
      };
    `,
    waitMs: 400,
  },
  {
    name: 'window-controls-peek',
    js: `
      const peek = document.querySelector('.top-peek');
      if (peek) peek.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      await window.__t.sleep(600);
      const bar = document.querySelector('.topbar');
      const right = document.querySelector('.topbar-right');
      const btn = document.querySelector('.win-btn');
      const rect = btn ? btn.getBoundingClientRect() : null;
      return {
        peekStrip: !!peek,
        topbarPeek: bar ? bar.classList.contains('is-peek') : false,
        rightVisible: window.__t.visible(right),
        winBtnsVisible: window.__t.all('.win-btn').filter((el) => window.__t.visible(el)).length,
        winBtnRect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        winBtnTitles: window.__t.all('.win-btn').map((el) => el.getAttribute('title') || ''),
      };
    `,
    waitMs: 900,
    shot: true,
  },
  {
    name: 'play-recent',
    shot: true,
    waitMs: 500,
    js: `
      const row = document.querySelector('.recent-item');
      if (!row) return { clicked: false, reason: 'no .recent-item' };
      const label = (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      window.__t.tap(row);
      const changed = await window.__t.waitFor(() => {
        const title = (document.querySelector('.pb-title')?.textContent || '').trim();
        return title && title !== '未在播放';
      }, 10000);
      await window.__t.sleep(3200);
      const cur = document.querySelectorAll('.pb-time')[0]?.textContent || '';
      const dur = document.querySelectorAll('.pb-time')[1]?.textContent || '';
      const fill = document.querySelector('.track-fill');
      const state = {
        clicked: true,
        rowLabel: label,
        playing: !!changed,
        title: (document.querySelector('.pb-title')?.textContent || '').trim(),
        artist: (document.querySelector('.pb-artist')?.textContent || '').trim(),
        source: (document.querySelector('.pb-source')?.textContent || '').trim(),
        cur,
        dur,
        fillWidth: fill ? fill.style.width : '',
        coverSrc: (document.querySelector('.pb-cover-img')?.getAttribute('src') || '').slice(0, 120),
      };
      return state;
    `,
  },
  {
    name: 'playback-advanced',
    waitMs: 2600,
    js: `
      const cur = document.querySelectorAll('.pb-time')[0]?.textContent || '';
      const dur = document.querySelectorAll('.pb-time')[1]?.textContent || '';
      const audioResources = performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((name) => name.includes('/api/stream'));
      return {
        cur,
        dur,
        advanced: cur !== '0:00',
        streamRequests: audioResources.length,
        lastStream: audioResources.slice(-1)[0]?.slice(0, 160) || null,
      };
    `,
    shot: true,
  },
  {
    name: 'open-lyrics',
    js: `
      const cover = document.querySelector('.pb-cover.is-clickable');
      if (!cover) return { clicked: false };
      window.__t.tap(cover);
      const opened = await window.__t.waitFor(() => document.querySelector('.app.is-lyrics-open'), 8000);
      await window.__t.sleep(1200);
      const lyrics = document.querySelector('.lyrics-view');
      return {
        clicked: true,
        opened: !!opened,
        lyricsTitle: (document.querySelector('.lyrics-title')?.textContent || '').trim(),
        lyricLines: window.__t.all('.lyrics-lines > *').length,
        lyricsText: (document.querySelector('.lyrics-lines')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        coverBg: getComputedStyle(document.querySelector('.lyrics-bg') || document.body).backgroundImage.slice(0, 80),
      };
    `,
    waitMs: 1600,
    shot: true,
  },
  {
    name: 'room-effect',
    js: `
      // 快捷设置 → 「歌词」页 → 播放效果 → 房间
      const trigger = document.querySelector('.pb-quick');
      if (!trigger) return { ok: false, reason: 'no .pb-quick' };
      window.__t.tap(trigger);
      await window.__t.waitFor(() => document.querySelector('.quick.is-open'), 5000);
      await window.__t.sleep(400);
      const tabs = window.__t.all('.quick-tabs .quick-tab, .quick-tabs button');
      const lyricTab = tabs.find((el) => (el.textContent || '').trim() === '歌词');
      if (!lyricTab) return { ok: false, reason: 'no 歌词 tab', tabs: tabs.map((el) => (el.textContent || '').trim()) };
      window.__t.tap(lyricTab);
      await window.__t.sleep(600);
      const segs = window.__t.all('.quick-effect-seg .quick-seg-btn');
      const labels = segs.map((el) => (el.textContent || '').trim());
      const room = segs.find((el) => (el.textContent || '').trim() === '房间');
      if (!room) return { ok: false, reason: 'no 房间 button', labels, tabHtml: (document.querySelector('.quick-body-inner')?.innerHTML || '').slice(0, 600) };
      window.__t.tap(room);
      await window.__t.sleep(500);
      window.__t.tap(trigger); // 收起快捷设置
      await window.__t.sleep(400);
      if (!document.querySelector('.app.is-lyrics-open')) {
        const cover = document.querySelector('.pb-cover.is-clickable');
        if (cover) window.__t.tap(cover);
      }
      const stage = await window.__t.waitFor(() => {
        const el = document.querySelector('.lyrics-stage.is-room');
        return el && el.classList.contains('is-painted') ? el : null;
      }, 15000);
      if (!stage) {
        const el = document.querySelector('.lyrics-stage.is-room');
        return {
          ok: false,
          reason: 'room stage not painted',
          labels,
          classes: el ? el.className : null,
          failed: el ? el.classList.contains('is-failed') : null,
        };
      }
      await window.__t.sleep(900);
      const canvas = stage.querySelector('canvas');
      return {
        ok: true,
        labels,
        classes: stage.className,
        canvas: canvas ? { w: canvas.width, h: canvas.height, rect: [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)] } : null,
        painted: stage.classList.contains('is-painted'),
        on: stage.classList.contains('is-on'),
        appLyricsOpen: !!document.querySelector('.app.is-lyrics-open'),
      };
    `,
    waitMs: 2400,
    shot: true,
  },
  {
    name: 'window-controls-messages',
    js: `
      const bridge = window.chrome && window.chrome.webview;
      if (!bridge) return { ok: false, reason: 'no bridge' };
      const original = bridge.postMessage;
      const captured = [];
      let forward = true;
      bridge.postMessage = (msg) => {
        captured.push(msg);
        if (forward) original.call(bridge, msg);
      };
      const btn = (title) => document.querySelector('.win-btn[title="' + title + '"]');
      // 最小化不可逆（CDP 唤不回来）：只拦消息不真正转发
      forward = false;
      if (btn('最小化')) window.__t.tap(btn('最小化'));
      await window.__t.sleep(200);
      const minimizeMsg = captured.find((m) => m && m.type === 'window' && m.action === 'minimize')
        ? JSON.parse(JSON.stringify(captured.find((m) => m && m.type === 'window' && m.action === 'minimize')))
        : null;
      // 最大化是可逆的：真实转发，验证 Electron 宿主窗口命令链路
      forward = true;
      const maxCount = captured.length;
      if (btn('最大化')) window.__t.tap(btn('最大化'));
      await window.__t.sleep(700);
      const afterMaximize = { w: innerWidth, h: innerHeight, captured: captured.length - maxCount };
      if (btn('最大化')) window.__t.tap(btn('最大化'));
      await window.__t.sleep(700);
      const afterRestore = { w: innerWidth, h: innerHeight };
      bridge.postMessage = original;
      const windowMsgs = captured.filter((m) => m && m.type === 'window');
      return {
        ok: !!minimizeMsg && windowMsgs.length >= 2,
        minimizeMsg,
        windowMsgs: windowMsgs.map((m) => ({ type: m.type, action: m.action })),
        afterMaximize,
        afterRestore,
      };
    `,
    waitMs: 600,
    shot: true,
  },
  {
    name: 'console-check',
    js: `
      return {
        note: 'console/exception 明细见 report.json 的 console 字段',
        bridgeKeys: Object.keys(window.chrome?.webview || {}),
        hasChrome: !!window.chrome,
        userAgent: navigator.userAgent.slice(0, 140),
      };
    `,
  },
];
