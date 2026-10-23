/**
 * 探索步骤：第一次在 Electron 里跑页面时用，摸清 DOM（顶栏 / 侧栏 / 首页卡片 / 播放条）。
 * 用法：STEPS=mac/shell/dev/steps/discover.mjs node mac/shell/dev/cdp-run.mjs
 */

export default [
  {
    name: 'boot-info',
    shot: true,
    js: `
      const info = await window.__t.shotInfo();
      info.hasSettings = !!window.__zilux2Debug;
      return info;
    `,
  },
  {
    name: 'rail',
    js: `
      const rail = document.querySelector('.rail');
      return {
        railFound: !!rail,
        railHtml: rail ? rail.outerHTML.slice(0, 3000) : null,
        buttons: window.__t.all('.rail-btn').map((el) => ({
          aria: el.getAttribute('aria-label'),
          text: (el.textContent || '').trim(),
          visible: window.__t.visible(el),
          cls: (el.className || '').toString().slice(0, 80),
        })),
      };
    `,
  },
  {
    name: 'topbar',
    js: `
      const top = document.querySelector('header, .topbar');
      return {
        topHtml: top ? top.outerHTML.slice(0, 5000) : null,
        winBtns: window.__t.all('.win-btn').map((el) => ({
          cls: (el.className || '').toString(),
          aria: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          visible: window.__t.visible(el),
        })),
      };
    `,
  },
  {
    name: 'home-body',
    shot: true,
    js: `
      await window.__t.sleep(2500);
      const app = document.querySelector('#app');
      return {
        text: (app.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1200),
        classes: Array.from(document.querySelectorAll('#app > *')).map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 100),
          hidden: el.classList.contains('is-hidden'),
        })),
        cards: window.__t.all('[class*="card"], .track, .track-row, .song, .home-card').slice(0, 12).map((el) => ({
          cls: (el.className || '').toString().slice(0, 80),
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        })),
      };
    `,
  },
  {
    name: 'airplay-hidden',
    js: `
      const hit = window.__t.all('*').filter((el) => (el.getAttribute && (el.getAttribute('aria-label') === '投送' || (el.textContent || '').trim() === '投送')) && window.__t.visible(el));
      return {
        visibleAirplayElements: hit.length,
        details: hit.slice(0, 6).map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 80),
          aria: el.getAttribute('aria-label'),
        })),
      };
    `,
  },
  {
    name: 'playerbar',
    js: `
      const bar = document.querySelector('.playerbar, .playerbar-wrap');
      return {
        found: !!bar,
        html: bar ? bar.outerHTML.slice(0, 4000) : null,
      };
    `,
  },
  {
    name: 'console-errors',
    js: `
      return { note: 'console/exception 由 cdp-run 收集进 report.json' };
    `,
  },
];
