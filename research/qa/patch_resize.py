# -*- coding: utf-8 -*-
"""给 spaceShell 加窗口缩放监听：最大化/拖动改变窗口大小后重建 WebGL 画布尺寸，避免拉伸模糊。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

anchor = "  const island = createIslandPlayer({\n    onError: (message) => showToast(message, 'error'),\n  });"
assert s.count(anchor) == 1, 'island anchor missing'
insert = """  let resizeTimer = 0;
  const onWindowResize = (): void => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      space?.resize();
    }, 80);
  };
  window.addEventListener('resize', onWindowResize);

""" + anchor
s = s.replace(anchor, insert, 1)

# destroy 清理
destroy_anchor = "      window.removeEventListener('keydown', onKeyDown);"
assert s.count(destroy_anchor) == 1, 'destroy anchor missing'
s = s.replace(
    destroy_anchor,
    destroy_anchor
    + "\n    window.clearTimeout(resizeTimer);\n    window.removeEventListener('resize', onWindowResize);",
    1,
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('resize listener added')
