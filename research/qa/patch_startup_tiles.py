# -*- coding: utf-8 -*-
"""启动期磁贴不出来：等在线源就绪 + 首页失败/空数据自动重试。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:70])
    s = s.replace(old, new, cnt)

# 1) 引入 libraryReady
rep("import { fetchLibraryOverview, fetchPlaylist, type MusicSource } from '../library';",
    "import { fetchLibraryOverview, fetchPlaylist, libraryReady, type MusicSource } from '../library';")

# 2) 就绪等待 + 重试计数（放在 liked 状态声明附近）
rep("  let likedViewOpen = false;",
'''  let likedViewOpen = false;
  let likedRetryCount = 0;

  /**
   * 启动竞速：宿主在线源端点可能晚于首次进入空间就绪。
   * 这里最多等 8 秒（就绪事件触发即返回），避免首屏磁贴因 not-ready 直接空白。
   */
  function waitOnlineReady(timeoutMs = 8000): Promise<boolean> {
    if (isMockOnline() || libraryReady()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        off();
        window.clearTimeout(timer);
        resolve(ok);
      };
      const off = onOnlineChange(() => finish(true));
      const timer = window.setTimeout(() => finish(libraryReady()), timeoutMs);
    });
  }''')

# 3) loadLikedTiles：等就绪 + 空数据重试
rep('''  async function loadLikedTiles(): Promise<void> {
    if (!space) return;
    space.setTilesVisible(true);
    likedPages.clear();
    likedPage = 1;
    likedTotal = 0;
    setStatus(`${likedLabel(likedSource)} · 我喜欢的音乐 · 正在读取…`);
    await showLikedPage(1, false);
  }''',
'''  async function loadLikedTiles(): Promise<void> {
    if (!space) return;
    space.setTilesVisible(true);
    likedPages.clear();
    likedPage = 1;
    likedTotal = 0;
    likedRetryCount = 0;
    setStatus(`${likedLabel(likedSource)} · 我喜欢的音乐 · 正在读取…`);
    const ready = await waitOnlineReady();
    if (!ready) {
      setStatus(`${likedLabel(likedSource)} · 在线源尚未就绪，稍后自动重试…`);
      window.setTimeout(() => {
        if (likedViewOpen && likedPages.size === 0) void loadLikedTiles();
      }, 1500);
      return;
    }
    await showLikedPage(1, false);
    // 首屏拿到空列表（宿主缓存冷启动偶发）时自动再取一次
    if (likedViewOpen && likedPages.size > 0) {
      const first = likedPages.get(1);
      if (first && first.length === 0 && likedRetryCount < 2) {
        likedRetryCount += 1;
        window.setTimeout(() => {
          if (likedViewOpen) void showLikedPage(1, false);
        }, 800);
      }
    }
  }''')

# 4) showLikedPage 失败自动重试
rep('''    } catch (error) {
      console.warn('[liked] 分页加载失败', error);
      setStatus(`${likedLabel(source)} · 我喜欢的音乐 · 第 ${target} 页加载失败，稍后重试`);
    } finally {''',
'''    } catch (error) {
      console.warn('[liked] 分页加载失败', error);
      setStatus(`${likedLabel(source)} · 我喜欢的音乐 · 第 ${target} 页加载失败，稍后自动重试`);
      if (trackedFirstPageRetry(target, source)) {
        window.setTimeout(() => {
          if (likedViewOpen && likedSource === source) void showLikedPage(target, false);
        }, 1400);
      }
    } finally {''')

# 5) 首屏失败重试的小工具（放在 showLikedPage 之前）
rep("  async function showLikedPage(page: number, animate: boolean): Promise<void> {",
'''  function trackedFirstPageRetry(page: number, source: MusicSource): boolean {
    if (page !== 1 || likedSource !== source) return false;
    if (likedRetryCount >= 3) return false;
    likedRetryCount += 1;
    return true;
  }

  async function showLikedPage(page: number, animate: boolean): Promise<void> {''')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('startup tile loading: wait for online ready + auto retry')
