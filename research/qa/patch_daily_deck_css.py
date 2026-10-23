import io

path = r'E:\Zilux2开发\web\src\styles\app.css'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    text = f.read()

nl = '\r\n' if '\r\n' in text else '\n'
marker = '.daily-card {'
if marker in text:
    print('already patched')
else:
    css = '''
/* ==================== 今日推荐：单卡片 + 封面叠放 ==================== */
.home-daily { padding-top: 2px; }
.daily-card {
  display: flex;
  align-items: center;
  gap: 34px;
  min-height: 196px;
  padding: 20px 24px;
  border-radius: var(--radius-l);
  border: 1px solid var(--line);
  background: linear-gradient(135deg, var(--surface-strong), var(--surface));
  box-shadow: var(--shadow-1);
}
.daily-deck {
  position: relative;
  flex: none;
  width: 156px;
  height: 156px;
  margin-right: 18px;
}
.daily-cover {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: 12px;
  background: var(--surface-hover);
  box-shadow: 0 12px 26px rgb(0 0 0 / 45%);
  transform-origin: 0% 100%;
  transition: transform .42s cubic-bezier(.22, 1, .36, 1), box-shadow .42s ease;
  will-change: transform;
}
.daily-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.daily-cover-0 { z-index: 5; cursor: pointer; }
.daily-cover-1 { z-index: 4; transform: translate3d(13px, -9px, 0) rotate(3deg) scale(.963); }
.daily-cover-2 { z-index: 3; transform: translate3d(24px, -17px, 0) rotate(6deg) scale(.928); }
.daily-cover-3 { z-index: 2; transform: translate3d(33px, -24px, 0) rotate(9deg) scale(.895); }
.daily-cover-4 { z-index: 1; transform: translate3d(41px, -30px, 0) rotate(12deg) scale(.864); }
.daily-deck:hover .daily-cover-0 { transform: translate3d(-2px, 2px, 0) scale(1.012); box-shadow: 0 18px 34px rgb(0 0 0 / 52%); }
.daily-deck:hover .daily-cover-1 { transform: translate3d(18px, -12px, 0) rotate(4.2deg) scale(.972); }
.daily-deck:hover .daily-cover-2 { transform: translate3d(31px, -22px, 0) rotate(8deg) scale(.94); }
.daily-deck:hover .daily-cover-3 { transform: translate3d(42px, -30px, 0) rotate(11.5deg) scale(.908); }
.daily-deck:hover .daily-cover-4 { transform: translate3d(52px, -37px, 0) rotate(15deg) scale(.876); }
.daily-play {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgb(255 255 255 / 22%);
  background: rgb(12 13 16 / 62%);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transform: translateY(8px) scale(.9);
  backdrop-filter: blur(10px) saturate(1.2);
  transition: opacity .26s ease, transform .3s cubic-bezier(.22, 1.4, .36, 1), background .2s ease;
}
.daily-deck:hover .daily-play,
.daily-play:focus-visible { opacity: 1; transform: none; }
.daily-play:hover { background: var(--accent); color: var(--accent-contrast); border-color: transparent; }
.daily-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.daily-kicker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--accent);
}
.daily-title {
  margin: 0;
  font-size: clamp(20px, 1.6vw, 26px);
  font-weight: 650;
  line-height: 1.2;
  color: var(--text);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.daily-meta { font-size: 13px; color: var(--muted); }
.daily-actions { display: flex; gap: 10px; margin-top: 12px; }
.daily-cover.is-empty {
  display: grid;
  place-items: center;
  color: var(--muted);
  border: 1px dashed var(--line-strong);
  background: var(--surface);
}
.daily-card.is-empty .daily-deck { width: 118px; height: 118px; }
@media (max-width: 900px) {
  .daily-card { gap: 20px; padding: 16px; }
  .daily-deck { width: 122px; height: 122px; margin-right: 14px; }
}
'''
    text = text.rstrip() + nl + css.replace('\n', nl)
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    print('app.css appended, newline=%r' % nl)
