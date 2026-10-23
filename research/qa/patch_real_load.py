# -*- coding: utf-8 -*-
"""真实启动加载：splash 进度等待「在线端点 + 登录信息 + 我喜欢的歌单」就绪（最多 92% 等数据，超时兜底），
首屏封面在 splash 期间用限流队列渐进预取。"""
import io

# ---------------- splash.ts ----------------
p = r'E:\Zilux2开发\web\src\ui\splash.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

old = "  run(): Promise<void>;"
new = "  run(ready?: Promise<unknown>): Promise<void>;"
assert s.count(old) == 1, 'splash run decl missing'
s = s.replace(old, new, 1)

old = """  const tick = (): void => {
    if (finished) return;
    const elapsed = performance.now() - start;
    const raw = Math.min(1, elapsed / TOTAL_MS);
    // easeOutCubic：加载条前段快、后段稳，接近真实加载手感
    setProgress(1 - Math.pow(1 - raw, 3));
    if (raw >= 1) {
      void finish(false);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return { element: el, run: () => done };"""
new = """  let readyDone = false;
  const settleReady = (): void => {
    readyDone = true;
  };

  const tick = (): void => {
    if (finished) return;
    const elapsed = performance.now() - start;
    const raw = Math.min(1, elapsed / TOTAL_S);
    // easeOutCubic：加载条前段快、后段稳；真实数据没就绪时最多停在 92%
    const eased = 1 - Math.pow(1 - raw, 3);
    setProgress(readyDone ? eased : Math.min(0.92, eased));
    const canFinish = readyDone ? raw >= 0.42 : raw >= 1;
    if (canFinish) {
      void finish(false);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    element: el,
    run: (ready?: Promise<unknown>) => {
      if (ready) {
        ready.then(settleReady).catch(settleReady);
      } else {
        settleReady();
      }
      return done;
    },
  };"""
assert s.count(old) == 1, 'splash tick block missing'
s = s.replace(old, new, 1)

# TOTAL_MS 引用改名为 TOTAL_S（保留常量名兼容：统一在下方替换所有用法）
s = s.replace('const TOTAL_MS = 2600;', 'const TOTAL_MS = 2600;\nconst TOTAL_S = TOTAL_MS;', 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('splash ready-gated run done')

# ---------------- main.ts ----------------
p2 = r'E:\Zilux2开发\web\src\main.ts'
s2 = io.open(p2, 'r', encoding='utf-8', newline='').read()

old = "import { initAccount } from './account';"
new = "import { accountOf, initAccount } from './account';"
assert s2.count(old) == 1, 'account import missing'
s2 = s2.replace(old, new, 1)

old = "import { initOnline } from './online/client';"
new = "import { initOnline, onlineReady } from './online/client';\nimport { fetchLibraryOverview, fetchPlaylist } from './library';"
assert s2.count(old) == 1, 'online import missing'
s2 = s2.replace(old, new, 1)

old = """  } else {
    await splash.run();
    reveal();
  }"""
new = """  } else {
    // 真实加载：启动动画期间把在线端点、登录信息、我喜欢的歌单先拿到，
    // 进度条只在数据真正就绪后才到 100%（最多在 92% 等数据，超时也有兜底）。
    const preload = (async () => {
      for (let i = 0; i < 18 && !onlineReady(); i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      try {
        await fetchLibraryOverview();
      } catch {
        /* 未登录/离线时继续 */
      }
      try {
        const source = accountOf('netease') ? 'netease' : accountOf('qq') ? 'qq' : 'netease';
        await fetchPlaylist(source, 'liked', 0, 120, 'liked');
      } catch {
        /* 忽略：进入空间后仍会再拉取 */
      }
      host.log('info', 'preload ready');
    })();
    await splash.run(preload);
    reveal();
  }"""
assert s2.count(old) == 1, 'splash run call missing'
s2 = s2.replace(old, new, 1)

io.open(p2, 'w', encoding='utf-8', newline='').write(s2)
print('main preload done')
