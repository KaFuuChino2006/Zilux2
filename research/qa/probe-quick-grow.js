(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const trigger = document.querySelector('.pb-quick');
  if (trigger && !document.querySelector('.quick.is-open')) trigger.click();
  await wait(250);
  const tab = [...document.querySelectorAll('.quick-tab')].find((b) => b.textContent.trim() === '歌词');
  if (tab) tab.click();
  await wait(500);
  const cellOf = (title) => [...document.querySelectorAll('.quick-cell')].find((c) => c.querySelector('.quick-cell-title')?.textContent === title);
  const describe = (title) => {
    const cell = cellOf(title);
    if (!cell) return null;
    const thumb = cell.querySelector('.quick-seg-thumb');
    return {
      title,
      segWidth: cell.querySelector('.quick-seg-slider')?.offsetWidth,
      thumb: thumb ? { w: thumb.style.width, x: thumb.style.transform, realW: thumb.offsetWidth } : null,
      btns: [...cell.querySelectorAll('.quick-seg-btn')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('is-on'), w: b.offsetWidth, l: b.offsetLeft })),
    };
  };
  const panel = document.querySelector('.quick-panel');
  return {
    panelOpen: !!document.querySelector('.quick.is-open'),
    panelDisplay: panel ? getComputedStyle(panel).display : null,
    panelBox: panel ? { w: panel.offsetWidth, h: panel.offsetHeight } : null,
    cells: [...document.querySelectorAll('.quick-cell')].map((c) => c.querySelector('.quick-cell-title')?.textContent),
    color: describe('歌词颜色'),
    grow: describe('动效'),
    stored: localStorage.getItem('zilux2.lyricGrow'),
  };
})()
