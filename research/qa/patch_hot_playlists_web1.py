import io

client_path = r'E:\Zilux2开发\web\src\online\client.ts'
app_path = r'E:\Zilux2开发\web\src\ui\app.ts'
home_path = r'E:\Zilux2开发\web\src\ui\home.ts'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


# ---------- 1) client.ts: 热门歌单接口 ----------
client = load(client_path)
nl = '\r\n' if '\r\n' in client else '\n'
anchor = "export async function fetchLyric(source: OnlineSource, id: string): Promise<OnlineLyric> {"
assert client.count(anchor) == 1, 'client fetchLyric anchor'
addition = '''/** QQ 音乐「音乐馆」热门歌单（宿主 /api/playlists/hot）。 */
export interface HotPlaylist {
  source: OnlineSource;
  id: string;
  title: string;
  cover: string;
  count: number;
  creator?: string;
}

export async function fetchHotPlaylists(source: OnlineSource = 'qq', limit = 24): Promise<HotPlaylist[]> {
  const data = await api<{ source: string; playlists: HotPlaylist[] }>('/api/playlists/hot', {
    source,
    limit: String(limit),
  });
  return Array.isArray(data.playlists) ? data.playlists : [];
}

'''.replace('\n', nl)
client = client.replace(anchor, addition + anchor)
save(client_path, client)
print('client.ts fetchHotPlaylists added')

# ---------- 2) home.ts: 推荐歌单不再要求登录 ----------
home = load(home_path)
nlh = '\r\n' if '\r\n' in home else '\n'
old = "  private buildPlaylistSection(data: HomeData): HTMLElement | null {\n    if (!data.loggedIn || data.playlists.length === 0) return null;"
new = "  private buildPlaylistSection(data: HomeData): HTMLElement | null {\n    if (data.playlists.length === 0) return null;"
old = old.replace('\n', nlh)
new = new.replace('\n', nlh)
assert home.count(old) == 1, 'home playlist gate anchor'
home = home.replace(old, new)
old2 = "      h('h2', { class: ui.sectionTitle(), text: '推荐歌单' }),"
new2 = "      h('h2', { class: ui.sectionTitle(), text: '热门歌单' }),"
assert home.count(old2) == 1, 'home section title anchor'
home = home.replace(old2, new2)
save(home_path, home)
print('home.ts hot playlist section adjusted')
