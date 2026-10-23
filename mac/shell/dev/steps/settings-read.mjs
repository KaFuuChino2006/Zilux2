/**
 * 设置持久化读取：重启后应读到 settings-write.mjs 写入的值（volume 0.41 / quality standard / startMaximized true）。
 * 同时验证 startMaximized=true 时宿主窗口以最大化启动。
 */
const HELPERS = `
  const bridge = window.chrome.webview;
  const captured = [];
  const listener = (event) => captured.push(event.data);
  bridge.addEventListener('message', listener);
  const waitHost = (predicate, timeout = 5000) => window.__t.waitFor(() => captured.find((m) => m && m.type === 'host' && predicate(m)), timeout);
`;

export default [
  {
    name: 'settings-loaded-from-disk',
    js: `
      ${HELPERS}
      bridge.postMessage({ v: 1, type: 'settings', action: 'request' });
      const snap = await waitHost((m) => m.event === 'settings' && m.state);
      bridge.removeEventListener('message', listener);
      return {
        ok: !!snap
          && snap.state.playback.volume === 0.41
          && snap.state.playback.quality === 'standard'
          && snap.state.general.startMaximized === true
          && snap.state.playback.lyricsAutoOpen === false,
        state: snap?.state,
      };
    `,
  },
  {
    name: 'window-started-maximized',
    js: `
      await window.__t.sleep(300);
      return {
        ok: window.outerWidth >= screen.availWidth - 8 && window.outerHeight >= screen.availHeight - 8,
        outer: [window.outerWidth, window.outerHeight],
        avail: [screen.availWidth, screen.availHeight],
        screenX: window.screenX,
        screenY: window.screenY,
      };
    `,
  },
  {
    name: 'settings-restore-defaults',
    js: `
      ${HELPERS}
      bridge.postMessage({ v: 1, type: 'settings', action: 'reset' });
      const snap = await waitHost((m) => m.event === 'settings' && m.state && m.state.playback.volume === 0.72);
      await window.__t.sleep(900);
      bridge.removeEventListener('message', listener);
      return { ok: !!snap && snap.state.general.startMaximized === false, state: snap?.state };
    `,
  },
];
