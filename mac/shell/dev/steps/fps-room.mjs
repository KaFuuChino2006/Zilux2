/**
 * 房间效果帧率粗测：复现「播放 → 歌词页 → 播放效果=房间」，再用 requestAnimationFrame 计数 1 秒。
 * 仅用于验收报告（浏览器主线程 rAF 帧数，非 GPU 计时）。
 */

export default [
  {
    name: 'setup-room',
    js: `
      await window.__t.waitForSelector('.recent-item', 20000);
      const row = document.querySelector('.recent-item');
      if (!row) return { ok: false, reason: 'no recent item' };
      window.__t.tap(row);
      await window.__t.sleep(2500);
      const cover = document.querySelector('.pb-cover.is-clickable') || document.querySelector('.pb-cover');
      if (cover) window.__t.tap(cover);
      await window.__t.sleep(1500);
      const quick = document.querySelector('.pb-quick');
      if (quick) window.__t.tap(quick);
      await window.__t.waitFor(() => document.querySelector('.quick.is-open'), 5000);
      const lyricTab = window.__t.all('.quick-tabs button').find((el) => (el.textContent || '').trim() === '歌词');
      if (lyricTab) window.__t.tap(lyricTab);
      await window.__t.sleep(500);
      const roomBtn = window.__t.all('.quick-effect-seg .quick-seg-btn').find((el) => (el.textContent || '').trim() === '房间');
      if (roomBtn) window.__t.tap(roomBtn);
      await window.__t.sleep(600);
      if (quick) window.__t.tap(quick); // 收起快捷设置
      await window.__t.sleep(400);
      const painted = await window.__t.waitFor(() => {
        const el = document.querySelector('.lyrics-stage.is-room');
        return el && el.classList.contains('is-painted') ? el : null;
      }, 15000);
      await window.__t.sleep(1200);
      const panel = document.querySelector('.quick.is-open');
      if (panel && quick) window.__t.tap(quick); // 若快捷设置还开着，收起它
      await window.__t.sleep(700);
      const roomStage = painted || document.querySelector('.lyrics-stage.is-room');
      return {
        ok: !!painted,
        classes: roomStage ? roomStage.className : null,
        stageCount: window.__t.all('.lyrics-stage').length,
        canvas: (() => { const c = roomStage ? roomStage.querySelector('canvas') : null; return c ? [c.width, c.height] : null; })(),
        effectLabels: window.__t.all('.quick-effect-seg .quick-seg-btn').map((el) => (el.textContent || '').trim()),
        roomBtnFound: !!roomBtn,
        lyricsOpen: !!document.querySelector('.app.is-lyrics-open'),
      };
    `,
    shot: true,
  },
  {
    name: 'measure-fps',
    js: `
      const frames = await new Promise((resolve) => {
        let count = 0;
        const started = performance.now();
        const loop = () => {
          count += 1;
          if (performance.now() - started < 1000) requestAnimationFrame(loop);
          else resolve(count);
        };
        requestAnimationFrame(loop);
      });
      const quick = document.querySelector('.pb-quick');
      if (quick) window.__t.tap(quick); // 关掉快捷设置，截一张纯房间图
      await window.__t.sleep(800);
      return { ok: frames >= 30, rafFramesPerSecond: frames };
    `,
    shot: true,
  },
];
