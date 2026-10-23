/**
 * 宿主协议专项验证（settings / fonts / airplay / window / log / local / audio / media）。
 * 页面侧直接通过 window.chrome.webview 发原始消息，并监听宿主回包。
 * 运行前建议清空 USER_DATA；运行后检查 userData/settings.json 是否落盘（由外部脚本做）。
 */

const HELPERS = `
  const bridge = window.chrome && window.chrome.webview;
  if (!bridge) throw new Error('window.chrome.webview 不存在');
  const captured = [];
  const listener = (event) => captured.push(event.data);
  bridge.addEventListener('message', listener);
  const send = (message) => bridge.postMessage(message);
  const waitHost = (predicate, timeout = 5000) => window.__t.waitFor(() => captured.find((m) => m && m.type === 'host' && predicate(m)), timeout);
  const finish = () => bridge.removeEventListener('message', listener);
`;

export default [
  {
    name: 'settings-request-snapshot',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'settings', action: 'request' });
      const snap = await waitHost((m) => m.event === 'settings' && m.state);
      finish();
      if (!snap) return { ok: false, reason: 'no settings snapshot' };
      const s = snap.state;
      return {
        ok: true,
        version: snap.version,
        hasPayloadSettings: !!snap.payload?.settings,
        general: s.general,
        appearance: s.appearance,
        playback: s.playback,
        keys: Object.keys(s),
      };
    `,
  },
  {
    name: 'settings-patch',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'settings', action: 'patch', patch: { appearance: { theme: 'frost', lyricsSize: 'large' }, playback: { volume: 0.33, quality: 'lossless', searchLimit: 30 } } });
      const snap = await waitHost((m) => m.event === 'settings' && m.state && m.state.playback.volume === 0.33);
      finish();
      return {
        ok: !!snap,
        volume: snap?.state?.playback?.volume,
        quality: snap?.state?.playback?.quality,
        searchLimit: snap?.state?.playback?.searchLimit,
        lyricsSize: snap?.state?.appearance?.lyricsSize,
      };
    `,
  },
  {
    name: 'settings-patch-invalid',
    js: `
      ${HELPERS}
      // 非法值应被夹紧/回落到默认；未 patch 的字段（lyricsSize='large'）保持不变。
      send({ v: 1, type: 'settings', action: 'patch', patch: { playback: { volume: 3, quality: 'ultra', searchLimit: 1 }, general: { splash: 'yes' } } });
      const snap = await waitHost((m) => m.event === 'settings' && m.state && m.state.playback.volume === 1 && m.state.playback.quality === 'high', 5000);
      finish();
      return {
        ok: !!snap
          && snap.state.playback.searchLimit === 20
          && snap.state.general.splash === true
          && snap.state.appearance.lyricsSize === 'large',
        volume: snap?.state?.playback?.volume,
        quality: snap?.state?.playback?.quality,
        searchLimit: snap?.state?.playback?.searchLimit,
        splash: snap?.state?.general?.splash,
        lyricsSize: snap?.state?.appearance?.lyricsSize,
      };
    `,
  },
  {
    name: 'settings-reset',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'settings', action: 'reset' });
      const snap = await waitHost((m) => m.event === 'settings' && m.state && m.state.playback.volume === 0.72 && m.state.playback.quality === 'high');
      finish();
      return {
        ok: !!snap,
        volume: snap?.state?.playback?.volume,
        quality: snap?.state?.playback?.quality,
        searchLimit: snap?.state?.playback?.searchLimit,
        lyricsSize: snap?.state?.appearance?.lyricsSize,
        splash: snap?.state?.general?.splash,
      };
    `,
  },
  {
    name: 'fonts-message',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'fonts' });
      const fonts = await waitHost((m) => m.event === 'fonts');
      finish();
      const families = fonts?.payload?.families || [];
      return { ok: families.length > 0, count: families.length, sample: families.slice(0, 8) };
    `,
  },
  {
    name: 'airplay-idle',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'airplay', action: 'scan' });
      const airplay = await waitHost((m) => m.event === 'airplay');
      const afterScan = captured.filter((m) => m && m.type === 'host' && m.event === 'airplay').length;
      send({ v: 1, type: 'airplay', action: 'connect', deviceId: 'x' });
      await window.__t.sleep(400);
      const states = captured.filter((m) => m && m.type === 'host' && m.event === 'airplay').map((m) => m.payload?.state);
      finish();
      return { ok: airplay?.payload?.state === 'idle', state: airplay?.payload?.state, afterScan, states };
    `,
  },
  {
    name: 'window-chrome-color',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'window', action: 'chromeColor', color: '#112233' });
      await window.__t.sleep(500);
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      finish();
      return { ok: true, bodyBg };
    `,
  },
  {
    name: 'drag-resize-media-audio-noop',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'drag' });
      send({ v: 1, type: 'resize', edge: 'right' });
      send({ v: 1, type: 'media', payload: { durationMs: 1000, positionMs: 500, playing: true, title: 'noop-test' } });
      send({ v: 1, type: 'audio', payload: { samples: [0, 0.1, 0.2], sampleRate: 48000 } });
      send({ v: 1, type: 'log', level: 'info', message: '[protocol-test] hello from page' });
      await window.__t.sleep(400);
      finish();
      return { ok: true, stillAlive: !!document.querySelector('#app'), title: document.title };
    `,
  },
  {
    name: 'local-pick-cancel',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'local', action: 'pick' });
      const cancel = await waitHost((m) => m.event === 'localCancel', 4000);
      finish();
      return { ok: !!cancel, event: cancel?.event };
    `,
  },
  {
    name: 'unknown-messages-safe',
    js: `
      ${HELPERS}
      send({ v: 1, type: 'nonsense', foo: 'bar' });
      send({ v: 1, type: 'host', event: 'hack' });
      send({ foo: 'no-type' });
      send(null);
      send('plain string');
      await window.__t.sleep(500);
      finish();
      return { ok: !!document.querySelector('#app'), pageAlive: document.readyState };
    `,
  },
];
