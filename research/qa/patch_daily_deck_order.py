import io

path = r'E:\Zilux2开发\web\src\ui\home.ts'
with io.open(path, 'r', encoding='utf-8', newline='') as f:
    text = f.read()

nl = '\r\n' if '\r\n' in text else '\n'
old = """    const layers = Array.from(deck.querySelectorAll<HTMLDivElement>('.daily-cover')).filter(
      (layer) => !layer.classList.contains('is-ghost'),
    );""".replace('\n', nl)
new = """    // 注意：DOM 里的叠放层是倒序插入的，必须按 .daily-cover-N 的序号排序，
    // 否则会把最底层的图当成最上面一层，出现「封面和正在播放的歌对不上」。
    const layerIndex = (layer: HTMLDivElement): number => {
      const matched = /daily-cover-(\\d+)/.exec(layer.className);
      return matched ? Number(matched[1]) : 99;
    };
    const layers = Array.from(deck.querySelectorAll<HTMLDivElement>('.daily-cover'))
      .filter((layer) => !layer.classList.contains('is-ghost'))
      .sort((a, b) => layerIndex(a) - layerIndex(b));""".replace('\n', nl)
assert text.count(old) == 1, 'layers anchor not found: %d' % text.count(old)
text = text.replace(old, new)

with io.open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('home.ts daily deck layer order fixed')
