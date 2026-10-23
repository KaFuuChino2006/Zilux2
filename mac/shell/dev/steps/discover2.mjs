/**
 * 探索步骤 2：窗口按钮可见性、首页「最近播放」可点元素、播放 → 打开歌词页。
 */

export default [
  {
    name: 'chrome-layout',
    js: `
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display, vis: getComputedStyle(el).visibility };
      };
      return {
        winBtns: rect(document.querySelector('.win-btns')),
        winBtnCount: window.__t.all('.win-btn').length,
        winBtnRects: window.__t.all('.win-btn').map((el) => rect(el)),
        accountWrap: rect(document.querySelector('.account-wrap')),
        topbar: rect(document.querySelector('.topbar')),
        topbarChildren: window.__t.all('.topbar > *').map((el) => ({ cls: (el.className || '').toString(), rect: rect(el) })),
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      };
    `,
  },
  {
    name: 'recent-section',
    js: `
      const headings = window.__t.all('*').filter((el) => el.children.length === 0 && (el.textContent || '').trim() === '最近播放');
      const heading = headings[0];
      let container = heading;
      for (let i = 0; i < 6 && container; i += 1) {
        if (container.querySelectorAll('button, [role="button"]').length >= 3) break;
        container = container.parentElement;
      }
      return {
        headingFound: !!heading,
        containerCls: container ? (container.className || '').toString() : null,
        html: container ? container.outerHTML.slice(0, 4000) : null,
      };
    `,
  },
  {
    name: 'play-first-recent',
    shot: true,
    waitMs: 2500,
    js: `
      const row = window.__t.all('button, [role="button"], .track, .recent-item, .row').find((el) => {
        const text = (el.textContent || '').trim();
        return text.includes('Sacred') || text.includes('心做し');
      });
      if (!row) return { clicked: false, reason: 'recent row not found' };
      window.__t.tap(row);
      await window.__t.sleep(1200);
      return {
        clicked: true,
        rowTag: row.tagName.toLowerCase(),
        rowCls: (row.className || '').toString().slice(0, 120),
        playerbar: (document.querySelector('.playerbar')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        playerbarCls: (document.querySelector('.playerbar')?.className || '').toString(),
      };
    `,
  },
  {
    name: 'playerbar-state',
    js: `
      return {
        title: (document.querySelector('.pb-title')?.textContent || '').trim(),
        artist: (document.querySelector('.pb-artist')?.textContent || '').trim(),
        time: (document.querySelector('.pb-time, .pb-times, .pb-progress')?.textContent || '').trim(),
        coverTitle: document.querySelector('.pb-cover')?.getAttribute('title') || '',
        mainBtnTitle: document.querySelector('.pb-btn.is-main')?.getAttribute('title') || '',
        likeBtnClass: (document.querySelector('.pb-like, .pb-btn[title*="喜欢"]')?.className || '').toString(),
      };
    `,
  },
  {
    name: 'open-lyrics',
    shot: true,
    waitMs: 1500,
    js: `
      const cover = document.querySelector('.pb-cover.is-clickable') || document.querySelector('.pb-cover');
      if (!cover) return { clicked: false };
      window.__t.tap(cover);
      await window.__t.sleep(1200);
      const lyrics = document.querySelector('.lyrics-view');
      return {
        clicked: true,
        lyricsView: !!lyrics,
        lyricsCls: (lyrics?.className || '').toString(),
        text: (lyrics?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      };
    `,
  },
  {
    name: 'lyrics-controls',
    js: `
      const lyrics = document.querySelector('.lyrics-view');
      if (!lyrics) return { found: false };
      const buttons = Array.from(lyrics.querySelectorAll('button, [role="button"], .pill, .seg-btn, [aria-label]')).slice(0, 40).map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 100),
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        visible: window.__t.visible(el),
      }));
      return { found: true, html: lyrics.outerHTML.slice(0, 3000), buttons };
    `,
  },
];
