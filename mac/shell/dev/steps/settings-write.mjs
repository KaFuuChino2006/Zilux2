/**
 * 设置持久化写入：patch 部分字段后等落盘（宿主 300ms 防抖）。
 * 配合 settings-read.mjs 验证跨重启持久化。
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
    name: 'settings-write',
    js: `
      ${HELPERS}
      bridge.postMessage({ v: 1, type: 'settings', action: 'patch', patch: {
        general: { startMaximized: true },
        playback: { volume: 0.41, quality: 'standard', lyricsAutoOpen: false },
      } });
      const snap = await waitHost((m) => m.event === 'settings' && m.state && m.state.playback.volume === 0.41);
      await window.__t.sleep(900); // 等宿主防抖写盘
      bridge.removeEventListener('message', listener);
      return {
        ok: !!snap && snap.state.playback.quality === 'standard' && snap.state.general.startMaximized === true,
        volume: snap?.state?.playback?.volume,
        quality: snap?.state?.playback?.quality,
        startMaximized: snap?.state?.general?.startMaximized,
        lyricsAutoOpen: snap?.state?.playback?.lyricsAutoOpen,
      };
    `,
  },
];
