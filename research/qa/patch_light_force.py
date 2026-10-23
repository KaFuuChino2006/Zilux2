import io

theme_path = r'E:\Zilux2开发\web\src\ui\theme.ts'
main_path = r'E:\Zilux2开发\web\src\main.ts'


def load(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def save(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


theme = load(theme_path)
nl = '\r\n' if '\r\n' in theme else '\n'
old = """function readTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark') return 'dark';
    if (saved === 'light') return 'light';
  } catch {
    /* 忽略 */
  }
  return 'light';
}""".replace('\n', nl)
new = """// 目前版本先固定浅色（白色）界面；等做主题切换 UI 时再恢复读 localStorage。
function readTheme(): ThemeName {
  return 'light';
}""".replace('\n', nl)
assert theme.count(old) == 1, 'readTheme anchor not found'
theme = theme.replace(old, new)
save(theme_path, theme)
print('theme.ts forced light')

main = load(main_path)
nl2 = '\r\n' if '\r\n' in main else '\n'
old2 = "  host.setChromeColor('#08090c');"
new2 = "  host.setChromeColor('#f3f1ea');"
assert main.count(old2) == 1, 'chrome color anchor not found'
main = main.replace(old2, new2)
save(main_path, main)
print('main.ts chrome color -> light')
