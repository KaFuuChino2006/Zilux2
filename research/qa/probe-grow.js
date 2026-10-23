// Preview experiment: active lyric line font-size grows with the line's singing progress.
// Injects CSS + a rAF hook that writes --grow; safe to wipe with location.reload().
(() => {
  const STYLE_ID = 'probe-grow-style';
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .lyrics-right .lyric-line.is-active {
      font-size: calc(
        clamp(20px, 2.05vw, 30px) +
        (clamp(23px, 2.42vw, 35px) - clamp(20px, 2.05vw, 30px)) * var(--grow, 0)
      ) !important;
      transition: color .3s var(--ease), opacity .42s var(--ease), transform .5s var(--ease-pop) !important;
    }
  `;
  document.head.append(style);

  const smooth = (p) => p * p * (3 - 2 * p);
  if (window.__growTimer) clearInterval(window.__growTimer);
  window.__growTimer = setInterval(() => {
    const line = document.querySelector('.lyric-line.is-active');
    if (!line) return;
    const p = Math.min(1, Math.max(0, parseFloat(line.style.getPropertyValue('--p') || '0')));
    line.style.setProperty('--grow', smooth(p).toFixed(3));
  }, 16);

  const line = document.querySelector('.lyric-line.is-active');
  return {
    injected: true,
    sampleFontSize: line ? getComputedStyle(line).fontSize : null,
    grow: line ? line.style.getPropertyValue('--grow') : null,
  };
})()
