# -*- coding: utf-8 -*-
import io

p = r'E:\Zilux2开发\docs\Zilux2-里程碑6-3D登录空间.md'
s = io.open(p, 'r', encoding='utf-8').read()
addition = """
## v2.31 修正（2026-10-19）：每页磁贴数量 + 空间背景图

- 「外观」面板的磁贴选项改为「每页磁贴数量」24 / 50 / 91 / 144：控制当前页铺开的封面数量与磁贴尺寸（24 = 6×4 大磁贴，144 = 16×9 密集），不是一次加载的歌曲数量；分批加载仍为每批 300 首，翻到当前批边界时自动加载下一批。
- 空间背景图修复：原实现把图片设到 `.space-shell` 的 `background-image`，被 `.space-shell::before` 的渐变层完全遮住（表现失效）；改为独立 `.space-bg` 层（z-index 0，位于 CSS 渐变之上、WebGL canvas 之下），上传/清除即时生效并写入 localStorage 持久化。
- 发布：`dist/Zilux2/Zilux2.exe` 27,280,267 B + web payload 822,536 B。
"""
if 'v2.31 修正' not in s:
    s = s.rstrip() + '\n' + addition
    io.open(p, 'w', encoding='utf-8').write(s)
    print('doc appended v2.31')
else:
    print('doc already has v2.31')
