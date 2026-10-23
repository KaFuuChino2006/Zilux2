# -*- coding: utf-8 -*-
import io

p = r"E:\Zilux2开发\web\src\styles\space.css"
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """.mg-corners {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  color: rgba(24, 28, 42, 0.62);
  font-family: ui-monospace, "Cascadia Mono", "Segoe UI Mono", monospace;
}"""
new = """.mg-corners {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  mix-blend-mode: difference;
  color: rgba(255, 255, 255, 0.68);
  font-family: ui-monospace, "Cascadia Mono", "Segoe UI Mono", monospace;
}"""
assert s.count(old) == 1
s = s.replace(old, new, 1)
s = s.replace("  color: rgba(20, 24, 38, 0.82);", "  color: rgba(255, 255, 255, 0.86);", 1)
s = s.replace("  color: rgba(20, 24, 38, 0.5);", "  color: rgba(255, 255, 255, 0.56);", 1)
s = s.replace("  color: rgba(20, 24, 38, 0.42);", "  color: rgba(255, 255, 255, 0.46);", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('css adjusted')
