# -*- coding: utf-8 -*-
"""中键平移方向修正：改成「抓住画面拖动」的手感（鼠标往右拖，画面跟着往右走）。"""
import io
import os
import subprocess
import sys

p = r'E:\Zilux2开发\web\src\three\floatScene.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = """      panTargetX = Math.min(6.5, Math.max(-6.5, panTargetX + dx * 0.0062 * zoom));
      panTargetY = Math.min(4.2, Math.max(-4.2, panTargetY + dy * 0.0052 * zoom));"""
new = """      panTargetX = Math.min(6.5, Math.max(-6.5, panTargetX - dx * 0.0062 * zoom));
      panTargetY = Math.min(4.2, Math.max(-4.2, panTargetY - dy * 0.0052 * zoom));"""
assert s.count(old) == 1, 'pan block missing'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('pan direction inverted (grab style)')

# 顺带应用「原磁贴放大」补丁
here = os.path.dirname(os.path.abspath(__file__))
sys.stdout.flush()
subprocess.run(
    [sys.executable, os.path.join(here, 'patch_inplace_focus.py')],
    check=True,
)
