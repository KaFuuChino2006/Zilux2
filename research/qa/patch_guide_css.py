import io
from pathlib import Path

nl = '\r\n'
css = Path(r"E:\Zilux2开发\web\src\styles\space.css")
raw = io.open(css, "r", encoding="utf-8", newline="").read()
if ".space-tip" in raw:
    print("already present")
    raise SystemExit(0)
extra = """
/* ── 新手引导 ─────────────────────────────────────────── */
.space-guide {
  position: fixed;
  inset: 0;
  z-index: 140;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 46%, rgba(4, 6, 12, 0.32), rgba(2, 3, 7, 0.72));
  opacity: 0;
  transition: opacity 0.28s ease;
  backdrop-filter: blur(3px);
}
.space-guide.is-open { opacity: 1; }
.space-guide-card {
  width: min(430px, calc(100vw - 56px));
  padding: 26px 26px 22px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: linear-gradient(160deg, rgba(26, 28, 36, 0.96), rgba(13, 15, 21, 0.97));
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.55);
  color: #eef1f7;
  transform: translateY(10px) scale(0.985);
  transition: transform 0.32s cubic-bezier(0.22, 0.8, 0.28, 1);
}
.space-guide.is-open .space-guide-card { transform: none; }
.space-guide-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: #8f96a6;
}
.space-guide-skip {
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 7px;
  transition: background 0.16s ease, color 0.16s ease;
}
.space-guide-skip:hover { background: rgba(255, 255, 255, 0.08); color: #dfe4ee; }
.space-guide-card h2 {
  margin: 16px 0 10px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.space-guide-card p {
  margin: 0;
  font-size: 13px;
  line-height: 1.78;
  color: #a7aebc;
}
.space-guide-dots { display: flex; gap: 6px; margin: 20px 0 18px; }
.space-guide-dots i {
  width: 22px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.14);
}
.space-guide-dots i.is-on { background: #e3cd97; }
.space-guide-next {
  width: 100%;
  height: 40px;
  border: 0;
  border-radius: 11px;
  background: #e3cd97;
  color: #15171d;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.16s ease;
}
.space-guide-next:hover { filter: brightness(1.06); }
.space-shell.theme-gold .space-guide-card { border-color: rgba(227, 205, 151, 0.28); }

/* ── 悬停 / 长按说明气泡 ───────────────────────────────── */
.space-tip {
  position: fixed;
  z-index: 160;
  max-width: 260px;
  padding: 7px 10px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.13);
  background: rgba(18, 20, 27, 0.96);
  color: #dfe4ee;
  font-size: 11.5px;
  line-height: 1.55;
  letter-spacing: 0.01em;
  pointer-events: none;
  opacity: 0;
  transform: translateY(-3px);
  transition: opacity 0.16s ease, transform 0.16s ease;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42);
}
.space-tip.is-on { opacity: 1; transform: none; }
.space-shell.theme-gold .space-tip { border-color: rgba(227, 205, 151, 0.26); }
"""
io.open(css, "w", encoding="utf-8", newline="").write(raw.rstrip() + extra.replace("\n", nl) + nl)
print("OK css")
