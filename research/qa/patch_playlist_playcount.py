import io

home_path = r'E:\Zilux2开发\web\src\ui\home.ts'
app_path = r'E:\Zilux2开发\web\src\ui\app.ts'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def sub(text, name, old, new):
    nl = '\r\n' if '\r\n' in text else '\n'
    old = old.replace('\n', nl)
    new = new.replace('\n', nl)
    got = text.count(old)
    assert got == 1, '%s: expected 1, got %d' % (name, got)
    return text.replace(old, new)


home = load(home_path)
nl = '\r\n' if '\r\n' in home else '\n'

home = sub(
    home,
    'home formatPlays',
    "export interface HomeCallbacks {",
    """/** 热门歌单的播放次数：12345 → 1.2 万次播放。 */
function formatPlays(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '歌单';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿次播放`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万次播放`;
  return `${Math.round(value)} 次播放`;
}

export interface HomeCallbacks {""",
)
home = sub(
    home,
    'home tile meta plays',
    "        h('span', { class: ui.tileMeta(), text: `${SOURCE_LABEL[item.source]} · ${item.count} 首` }),",
    "        h('span', { class: ui.tileMeta(), text: `${SOURCE_LABEL[item.source] ?? ''} · ${formatPlays(item.count)}` }),",
)
save(home_path, home)
print('home playlist meta -> play count')

app = load(app_path)
app = sub(
    app,
    'app formatPlays helper',
    "const WINDOW_ICON = {",
    """/** 热门歌单播放次数展示。 */
function formatPlays(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿次播放`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万次播放`;
  return `${Math.round(value)} 次播放`;
}

const WINDOW_ICON = {""",
)
app = sub(
    app,
    'app hot row meta plays',
    "            h('div', { class: 'row-artist', text: `${item.creator ? item.creator + ' · ' : ''}${item.count} 次播放` }),",
    "            h('div', { class: 'row-artist', text: `${item.creator ? item.creator + ' · ' : ''}${formatPlays(item.count)}` }),",
)
save(app_path, app)
print('app hot row -> formatted play count')
