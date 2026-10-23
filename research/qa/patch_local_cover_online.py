"""本地歌曲封面：没有内嵌封面时按「歌名」去在线源找一张并替换。"""
import io
from pathlib import Path

ROOT = Path(r"E:\Zilux2开发")
SHELL = ROOT / "web/src/ui/spaceShell.ts"


def load(path):
    raw = io.open(str(path), "r", encoding="utf-8", newline="").read()
    crlf = "\r\n" in raw
    return raw.replace("\r\n", "\n"), crlf


def save(path, text, crlf):
    io.open(str(path), "w", encoding="utf-8", newline="").write(
        text.replace("\n", "\r\n") if crlf else text
    )


def rep(text, old, new, count=1, tag=""):
    got = text.count(old)
    assert got == count, f"{tag} expect {count} got {got}"
    return text.replace(old, new)


shell, shell_crlf = load(SHELL)

state = """  /** 在线封面缓存：本地歌曲没有内嵌封面时按「歌名」去在线源找（key = 曲目 id） */
  const LOCAL_COVER_KEY = 'zilux2.localCovers';
  const localOnlineCovers = new Map<string, string>();
  let localCoverBusy = false;
  try {
    const rawCovers = window.localStorage.getItem(LOCAL_COVER_KEY);
    const parsedCovers = rawCovers ? (JSON.parse(rawCovers) as Record<string, string>) : {};
    for (const [coverKey, coverValue] of Object.entries(parsedCovers)) {
      if (typeof coverValue === 'string' && coverValue) localOnlineCovers.set(coverKey, coverValue);
    }
  } catch {
    host.log('warn', '[local] cover cache unreadable');
  }

  function persistLocalCovers(): void {
    try {
      window.localStorage.setItem(LOCAL_COVER_KEY, JSON.stringify(Object.fromEntries(localOnlineCovers)));
    } catch {
      // 忽略存储失败
    }
  }

  /** 本地歌曲没有内嵌封面时，按「歌名」去在线源找一张封面并替换磁贴。 */
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
      const found = localOnlineCovers.get(track.id);
      if (found) track.cover = found;
    }
    if (localViewOpen) {
      space?.setTiles(tilePayload(localTracks));
    }
  }

"""

shell = rep(
    shell,
    "  function localTitleOf(name: string): string {",
    state + "  function localTitleOf(name: string): string {",
    tag="cover-state",
)

shell = rep(
    shell,
    "        cover: entry.hasCover ? localCoverUrl(entry.rel) : localCoverFor(entry.rel || entry.name),",
    "        cover: entry.hasCover\n"
    "          ? localCoverUrl(entry.rel)\n"
    "          : (localOnlineCovers.get(id) ?? localCoverFor(entry.rel || entry.name)),",
    tag="cover-apply",
)

shell = rep(
    shell,
    """    showToast(
      localTracks.length > 0 ? `已载入本地歌曲 ${localTracks.length} 首` : '文件夹里没有找到音频文件',
      localTracks.length > 0 ? 'ok' : 'info',
    );
  }""",
    """    showToast(
      localTracks.length > 0 ? `已载入本地歌曲 ${localTracks.length} 首` : '文件夹里没有找到音频文件',
      localTracks.length > 0 ? 'ok' : 'info',
    );
    void resolveLocalCovers(payload, album);
  }""",
    tag="cover-kick",
)

save(SHELL, shell, shell_crlf)
print("OK: online cover")
