import io
from pathlib import Path

p = Path(r"E:\Zilux2开发\web\src\ui\spaceShell.ts")
raw = io.open(p, "r", encoding="utf-8", newline="").read()
crlf = "\r\n" in raw
text = raw.replace("\r\n", "\n")


def rep(old: str, new: str, count: int = 1) -> None:
    global text
    got = text.count(old)
    assert got == count, f"anchor count {got} != {count}: {old[:60]!r}"
    text = text.replace(old, new)


# 1) 文件名去掉扩展名，避免在线搜索时带上 .flac/.wav
rep(
    """  function localTitleOf(name: string): string {
    const stripped = name.replace(/^\\s*\\d{1,3}\\s*[._\\-、\\s]+/, '').trim();
    return stripped || name;
  }""",
    """  function localTitleOf(name: string): string {
    const base = name.replace(/\\.[a-z0-9]{2,5}$/i, '');
    const stripped = base.replace(/^\\s*\\d{1,3}\\s*[._\\-、\\s]+/, '').trim();
    return stripped || base || name;
  }""",
)

# 2) 在线封面：缓存键改成相对路径（稳定），查询词更干净，逐个日志
rep(
    """  /** 本地歌曲没有内嵌封面时，按「歌名」去在线源找一张封面并替换磁贴。 */
  async function resolveLocalCovers(payload: LocalLibraryPayload, album: string): Promise<void> {
    if (localCoverBusy) return;
    const pending = payload.tracks
      .filter((entry) => !entry.hasCover && !localOnlineCovers.get(localTrackUrl(entry.rel)))
      .slice(0, 40);
    if (pending.length === 0) return;
    localCoverBusy = true;
    let changed = false;
    try {
      for (const entry of pending) {
        const title = localTitleOf(entry.name);
        const query = album === '本地歌曲' ? title : `${title} ${album}`;
        for (const source of ['netease', 'qq'] as const) {
          try {
            const result = await searchOnline(source, query, 6);
            const candidate =
              result.tracks.find((item) => {
                const name = item.title ?? '';
                if (!name || !item.cover) return false;
                return name.includes(title) || title.includes(name);
              }) ?? result.tracks.find((item) => Boolean(item.cover));
            if (!candidate || !candidate.cover) continue;
            localOnlineCovers.set(localTrackUrl(entry.rel), candidate.cover);
            changed = true;
            host.log('info', `[local] cover online ${source}:${candidate.id} for ${entry.name}`);
            break;
          } catch (error) {
            host.log('warn', `[local] cover online failed ${source}: ${String(error)}`);
          }
        }
      }
    } finally {
      localCoverBusy = false;
    }
    if (!changed) return;
    persistLocalCovers();
    for (const track of localTracks) {
      if (localEmbeddedCovers.has(track.id)) continue;
      const found = localOnlineCovers.get(track.id);
      if (found) track.cover = found;
    }
    if (localViewOpen) {
      space?.setTiles(tilePayload(localTracks));
    }
  }""",
    """  /** 归一化歌名/歌手，用于在线封面匹配（去空格标点、统一大小写） */
  function localCoverKey(input: string): string {
    return input.toLowerCase().replace(/[^0-9a-z\\u3040-\\u30ff\\u4e00-\\u9fff]/g, '');
  }

  /** 本地歌曲没有内嵌封面时，按「歌名」去在线源找一张封面并替换磁贴。缓存键 = 相对路径。 */
  async function resolveLocalCovers(payload: LocalLibraryPayload, album: string): Promise<void> {
    if (localCoverBusy) return;
    const pending = payload.tracks.filter((entry) => !entry.hasCover && !localOnlineCovers.get(entry.rel)).slice(0, 40);
    if (pending.length === 0) return;
    localCoverBusy = true;
    let changed = false;
    try {
      for (const entry of pending) {
        const raw = localTitleOf(entry.name);
        const parts = raw.split(/\\s+-\\s+/);
        const title = parts.length > 1 ? parts.slice(1).join(' - ') : raw;
        const artist = parts.length > 1 ? parts[0] : '';
        const queries = [title, raw, artist ? `${title} ${artist}` : '', album && album !== '本地歌曲' ? `${title} ${album}` : ''].filter(
          (value) => value.trim().length > 0,
        );
        const target = localCoverKey(title);
        const artistKey = localCoverKey(artist);
        let found = '';
        for (const source of ['netease', 'qq'] as const) {
          for (const query of queries) {
            try {
              const result = await searchOnline(source, query, 8);
              const candidate = result.tracks.find((item) => {
                if (!item.cover) return false;
                const name = localCoverKey(item.title ?? '');
                if (!name || !target) return false;
                if (name.includes(target) || target.includes(name)) return true;
                return Boolean(artistKey) && localCoverKey(item.artist ?? '').includes(artistKey);
              });
              if (candidate?.cover) {
                found = candidate.cover;
                break;
              }
            } catch (error) {
              host.log('warn', `[local] cover online failed ${source}: ${String(error)}`);
            }
          }
          if (found) break;
        }
        if (!found) {
          host.log('info', `[local] cover none for ${entry.name}`);
          continue;
        }
        localOnlineCovers.set(entry.rel, found);
        changed = true;
        host.log('info', `[local] cover online ${entry.name} -> ${found}`);
      }
    } finally {
      localCoverBusy = false;
    }
    if (!changed) return;
    persistLocalCovers();
    payload.tracks.forEach((entry, index) => {
      const track = localTracks[index];
      if (!track || entry.hasCover) return;
      const found = localOnlineCovers.get(entry.rel);
      if (found) track.cover = found;
    });
    if (localViewOpen) {
      space?.setTiles(tilePayload(localTracks));
    }
  }""",
)

# 3) 建曲目时用相对路径作为封面缓存键
rep(
    """      if (entry.hasCover) {
        localEmbeddedCovers.add(id);
        // 有内嵌封面就不再用旧会话缓存里的在线封面
        localOnlineCovers.delete(id);
      }""",
    """      if (entry.hasCover) localEmbeddedCovers.add(id);""",
)

rep(
    """        cover: entry.hasCover
          ? localCoverUrl(entry.rel)
          : (localOnlineCovers.get(id) ?? localCoverFor(entry.rel || entry.name)),""",
    """        cover: entry.hasCover
          ? localCoverUrl(entry.rel)
          : (localOnlineCovers.get(entry.rel) ?? localCoverFor(entry.rel || entry.name)),""",
)

# 4) 清理旧缓存：URL 键的条目（迁移后不再使用）
rep(
    """    for (const [coverKey, coverValue] of Object.entries(parsedCovers)) {
      if (typeof coverValue === 'string' && coverValue) localOnlineCovers.set(coverKey, coverValue);
    }""",
    """    for (const [coverKey, coverValue] of Object.entries(parsedCovers)) {
      // 只接受相对路径键；旧的 URL 键（https://localmusic.local/...）会被丢弃后重新解析
      if (typeof coverValue === 'string' && coverValue && !coverKey.startsWith('http')) {
        localOnlineCovers.set(coverKey, coverValue);
      }
    }""",
)

out = text.replace("\n", "\r\n") if crlf else text
io.open(p, "w", encoding="utf-8", newline="").write(out)
print("OK: localTitleOf, resolveLocalCovers, coverCacheKeys")
