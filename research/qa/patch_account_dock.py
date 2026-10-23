"""右上角账号：多平台头像叠放 + 点击弹出小窗（不再用侧边 sheet）。"""
import io

PATH = r'E:\Zilux2开发\web\src\ui\app.ts'
text = io.open(PATH, 'r', encoding='utf-8', newline='').read()
eol = '\r\n' if '\r\n' in text else '\n'


def apply(label, old, new, expect=1):
    global text
    count = text.count(old)
    assert count == expect, f'{label}: found {count}, expected {expect}'
    text = text.replace(old, new)
    print(f'ok {label}')


# 1) 字段
apply(
    'fields',
    '  private accountBtn!: HTMLButtonElement;\n',
    '  private accountBtn!: HTMLButtonElement;\n'
    '  private accountWrap!: HTMLDivElement;\n'
    '  private accountPanel!: HTMLDivElement;\n'
    '  private accountPanelOpen = false;\n',
)

# 2) 顶栏：包一层 account-wrap，按钮点击开小窗
apply(
    'topbar button',
    """    this.accountBtn = h('button', { class: 'account-btn', title: '账号' }, icon('user', 18));
    this.accountBtn.addEventListener('click', () => this.openAccountSheet());
""",
    """    this.accountBtn = h('button', { class: 'account-btn account-stack', title: '账号', type: 'button' });
    this.accountBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.accountPanelOpen) this.closeAccountPanel();
      else this.openAccountPanel();
    });
    this.accountPanel = h('div', { class: 'account-panel' });
    this.accountWrap = h('div', { class: 'account-wrap' }, this.accountBtn, this.accountPanel);
    document.addEventListener('pointerdown', (event) => {
      if (!this.accountPanelOpen) return;
      const target = event.target;
      if (target instanceof Node && this.accountWrap.contains(target)) return;
      this.closeAccountPanel();
    });
""",
)

# 3) topbarRight 使用 accountWrap
apply(
    'topbar right wrap',
    "    const topbarRight = h('div', { class: 'topbar-right' }, this.accountBtn, winBtns);",
    "    const topbarRight = h('div', { class: 'topbar-right' }, this.accountWrap, winBtns);",
)

# 4) syncAccount：多个已登录平台头像叠放
apply(
    'syncAccount',
    """  private syncAccount(): void {
    const account = getAccounts().find((item) => item.loggedIn);
    this.accountBtn.textContent = '';
    this.accountBtn.append(account?.avatarDataUrl ? h('img', { src: account.avatarDataUrl }) : icon('user', 18));
    this.accountBtn.title = account ? `${SOURCE_LABEL[account.source]} · ${account.nickname ?? ''}` : '账号';
  }
""",
    """  private syncAccount(): void {
    const accounts = getAccounts().filter((item) => item.loggedIn);
    this.accountBtn.textContent = '';
    if (accounts.length === 0) {
      this.accountBtn.append(icon('user', 18));
      this.accountBtn.title = '账号';
    } else {
      for (const account of accounts.slice(0, 3)) {
        this.accountBtn.append(
          account.avatarDataUrl
            ? h('img', { src: account.avatarDataUrl, alt: SOURCE_LABEL[account.source] ?? account.source })
            : h('span', { class: `account-dot source-${account.source}`, text: sourceMeta(account.source).short }),
        );
      }
      this.accountBtn.title = accounts.map((item) => `${SOURCE_LABEL[item.source]} · ${item.nickname ?? '已登录'}`).join('\\n');
    }
    if (this.accountPanelOpen) this.renderAccountPanel();
  }
""",
)

# 5) openAccountSheet -> 小窗面板
old_sheet_start = "  private openAccountSheet(): void {\n    this.openSheet('账号', (body) => {\n"
assert text.count(old_sheet_start) == 1
start = text.index(old_sheet_start)
# 找到方法结尾：sheet 调用闭合 '\n    });\n  }\n'
end_marker = "\n    });\n  }\n"
end = text.index(end_marker, start) + len(end_marker)
assert end > start

new_panel = """  private openAccountPanel(): void {
    this.renderAccountPanel();
    this.accountPanel.classList.add('is-open');
    this.accountPanelOpen = true;
  }

  private closeAccountPanel(): void {
    this.accountPanel.classList.remove('is-open');
    this.accountPanelOpen = false;
  }

  /** 账号小窗内容：一个平台一行，头像/昵称/会员 + 登录或退出。 */
  private renderAccountPanel(): void {
    const panel = this.accountPanel;
    panel.textContent = '';
    const accounts = getAccounts().filter((item) => item.loggedIn);
    if (accounts.length === 0) {
      panel.append(h('div', { class: 'account-empty', text: '还没有登录任何平台\\n登录后可同步我喜欢的音乐与歌单' }));
    }
    for (const source of accountSourceIds() as AccountSource[]) {
      const info = accountOf(source);
      const action = h('button', {
        class: `btn${info.loggedIn ? '' : ' is-primary'}`,
        type: 'button',
        text: info.loggedIn ? '退出' : '登录',
      });
      action.addEventListener('click', (event) => {
        event.stopPropagation();
        if (info.loggedIn) {
          void logout(source).then(() => {
            toast('已退出');
            this.syncAccount();
          });
        } else {
          this.closeAccountPanel();
          this.openLogin(source);
        }
      });
      panel.append(
        h(
          'div',
          { class: 'account-row' },
          info.avatarDataUrl
            ? h('img', { class: 'account-row-avatar', src: info.avatarDataUrl, alt: '' })
            : h('span', { class: 'account-row-avatar account-dot', text: sourceMeta(source).short }),
          h(
            'div',
            { class: 'account-row-main' },
            h('div', { class: 'account-row-name', text: info.loggedIn ? info.nickname ?? '已登录' : `${SOURCE_LABEL[source]} 未登录` }),
            h('div', {
              class: 'account-row-sub',
              text: info.loggedIn ? `${SOURCE_LABEL[source]}${info.vip === true ? ' · 会员' : ''}` : '点击登录同步歌单',
            }),
          ),
          action,
        ),
      );
    }
  }
"""
text = text[:start] + new_panel + text[end:]
print('ok openAccountSheet -> panel')

# 6) Esc 优先关账号小窗
apply(
    'escape order',
    """    if (this.searchDockOpen) {
      this.closeSearchDock();
      return;
    }
""",
    """    if (this.searchDockOpen) {
      this.closeSearchDock();
      return;
    }
    if (this.accountPanelOpen) {
      this.closeAccountPanel();
      return;
    }
""",
)

io.open(PATH, 'w', encoding='utf-8', newline='').write(text)
print('saved app.ts')
