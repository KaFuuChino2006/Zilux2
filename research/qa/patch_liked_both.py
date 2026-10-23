# -*- coding: utf-8 -*-
"""我喜欢的音乐：同时接入网易云与 QQ 音乐，交替合并进磁贴墙。"""
import io

p = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
s = io.open(p, 'r', encoding='utf-8', newline='').read()

start = s.index('  async function loadLikedTiles(): Promise<void> {')
# 括号配对找函数结束
i = s.index('{', start)
depth = 0
end = None
while i < len(s):
    ch = s[i]
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
    i += 1
if end is None:
    raise SystemExit('cannot find function end')
# 吞掉函数后面的换行
while end < len(s) and s[end] in '\r\n':
    end += 1

new_fn = '''  async function loadLikedTiles(): Promise<void> {
    if (!space) return;
    space.setTilesVisible(true);
    setStatus('我喜欢的音乐 · 正在读取…');
    try {
      const overview = await fetchLibraryOverview();
      const sources = (['netease', 'qq'] as const).filter((source) => {
        const state = overview.sources.find((item) => item.source === source);
        return Boolean(state?.loggedIn && state.liked);
      });
      if (sources.length === 0) {
        space.setTiles([]);
        setStatus('我喜欢的音乐 · 暂无歌曲（请先在账号里登录平台）');
        return;
      }
      const lists = await Promise.all(
        sources.map(async (source) => {
          try {
            const detail = await fetchPlaylist(source, 'liked', 0, 120, 'liked');
            return detail.tracks;
          } catch (error) {
            console.warn(`[liked] ${source} 读取失败`, error);
            return [];
          }
        }),
      );
      // 两个平台交替合并，保证磁贴墙里两边都能出现
      const merged: typeof lists[number] = [];
      const longest = Math.max(0, ...lists.map((list) => list.length));
      for (let i = 0; i < longest; i += 1) {
        for (const list of lists) {
          const track = list[i];
          if (track) merged.push(track);
        }
      }
      const picked = merged.slice(0, 120);
      tileTracks = picked;
      space.setTiles(
        picked.map((track) => ({ title: track.title, artist: track.artist, cover: track.cover })),
      );
      const countText = sources
        .map(
          (source, index) =>
            `${source === 'netease' ? '网易云' : 'QQ'} ${lists[index]?.length ?? 0}`,
        )
        .join(' + ');
      setStatus(
        `我喜欢的音乐 · ${picked.length} 首（${countText}）· 拖动旋转视角 / 滚轮滚动`,
      );
    } catch (error) {
      console.warn('[liked] 读取失败', error);
      setStatus('我喜欢的音乐 · 读取失败，稍后重试');
    }
  }

'''
s = s[:start] + new_fn + s[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('liked merged from both sources')
