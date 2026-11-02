#!/usr/bin/env bash
#
# 安装 GitHub CLI（gh）并完成首次 GitHub 登录。
# 由 /wizard 生成；目标环境：Windows + Git Bash；官方来源 https://cli.github.com/
#
# 用法：在项目根目录运行
#   bash scripts/install-gh-cli.sh
#
# 说明：安装走官方 WinGet 包或官方 MSI；登录走 gh 自带的浏览器设备码流程。
# 凭据由 gh 自己保存在本机，本向导不会读取或写入任何令牌。
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE sets a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

# set_var NAME VALUE sets a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: author this section. One stage() per step the human takes.
# ──────────────────────────────────────────────────────────────────────────

# 本向导需要交互式终端：会等待确认，并可能触发 UAC 和浏览器登录。
if [[ ! -t 0 ]]; then
  printf '请在交互式 Git Bash 终端中运行：bash scripts/install-gh-cli.sh\n' >&2
  exit 1
fi

TOTAL_STAGES=5

GH_EXE=""
GH_EXE_WIN=""
GH_USER=""
AUTH_OK=0

# _find_gh: 输出 gh 可执行文件路径；找不到时返回 1。
_find_gh() {
  local cand
  if command -v gh >/dev/null 2>&1; then
    command -v gh
    return 0
  fi
  for cand in \
    "/c/Program Files/GitHub CLI/gh.exe" \
    "/c/Program Files (x86)/GitHub CLI/gh.exe" \
    "$HOME/AppData/Local/Programs/GitHub CLI/gh.exe"; do
    if [[ -x "$cand" ]]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}

# _gh_version_line: gh --version 的第一行（去掉 Windows 的 CR）。
_gh_version_line() {
  "$1" --version 2>/dev/null | sed -n '1p' | tr -d '\r'
}

banner "安装 GitHub CLI（gh）"

# ── Stage 1 · 环境预检 ────────────────────────────────────────────────────
stage "环境预检"
say "本向导将在这台 Windows 机器上安装 GitHub CLI（gh），并完成首次 GitHub 登录。"
step "官方站点：https://cli.github.com/（只从官方渠道安装）"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) note "系统：Windows（$(uname -m)）" ;;
  *) warn "本向导按 Windows + Git Bash 编写；当前系统 $(uname -s)，步骤可能需要调整。" ;;
esac

GH_EXE=$(_find_gh || true)
if [[ -n "$GH_EXE" ]]; then
  gh_ver=$(_gh_version_line "$GH_EXE" || true)
  say "已检测到 gh：$gh_ver"
  note "若版本偏旧，可运行 winget upgrade --id GitHub.cli 升级。"
else
  say "未检测到 gh，下一步从官方渠道安装。"
fi

if command -v winget.exe >/dev/null 2>&1; then
  say "winget 可用（$(winget.exe --version 2>/dev/null | tr -d '\r')）。"
else
  warn "未找到 winget；下一步改为手动下载官方 MSI。"
fi
note "安装需要管理员权限；稍后弹出 UAC 请点「是」。"
pause "按回车进入安装。"

# ── Stage 2 · 从官方站点安装 ──────────────────────────────────────────────
stage "从官方站点安装"
say "官方站点：https://cli.github.com/"
say "官网给出的 Windows 安装命令（WinGet）："
note "  winget install --id GitHub.cli"
if [[ -n "$GH_EXE" ]]; then
  note "已安装，跳过下载安装。"
else
  open_url "https://cli.github.com/"
  if command -v winget.exe >/dev/null 2>&1; then
    step "向导将执行：winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements"
    step "若弹出 UAC 管理员授权，请点「是」；安装通常需要 1–2 分钟。"
    if confirm "现在运行 winget 安装？"; then
      if winget.exe install --id GitHub.cli -e --source winget \
           --accept-package-agreements --accept-source-agreements; then
        say "winget 命令执行完毕。"
      else
        warn "winget 没有成功（网络、源或 UAC 被取消都可能），改用手动 MSI。"
      fi
    else
      warn "已跳过 winget，改用手动 MSI。"
    fi
  else
    warn "未找到 winget，改用手动 MSI。"
  fi

  GH_EXE=$(_find_gh || true)
  if [[ -z "$GH_EXE" ]]; then
    step "手动安装：打开 https://github.com/cli/cli/releases/latest"
    note "在页面底部 Assets 里下载 gh_*_windows_amd64.msi，双击安装（需要管理员权限）。"
    open_url "https://github.com/cli/cli/releases/latest"
    pause "MSI 安装完成后按回车继续。"
    GH_EXE=$(_find_gh || true)
  fi
fi
if [[ -n "$GH_EXE" ]]; then
  say "已找到 gh：$GH_EXE"
  GH_EXE_WIN=$(cygpath -w "$GH_EXE" 2>/dev/null || printf '%s' "$GH_EXE")
else
  warn "仍未找到 gh.exe。先把安装完成，再重跑本向导即可从验证步骤继续。"
  SKIPPED+=("安装 GitHub CLI：winget install --id GitHub.cli，或从 https://cli.github.com/ 下载 MSI")
fi

# ── Stage 3 · 验证安装与 PATH ─────────────────────────────────────────────
stage "验证安装与 PATH"
if [[ -z "$GH_EXE" ]]; then
  warn "没有可用的 gh.exe，跳过验证。完成安装后重跑本向导即可。"
  pause "按回车继续。"
else
  GH_DIR=$(dirname "$GH_EXE")
  case ":$PATH:" in
    *":$GH_DIR:"*) ;;
    *) export PATH="$GH_DIR:$PATH" ;;
  esac
  gh_ver=$(_gh_version_line "$GH_EXE" || true)
  say "gh 位置：${GH_EXE_WIN:-$GH_EXE}"
  say "版本：$gh_ver"
  step "请关闭所有已打开的终端（Git Bash / PowerShell / CMD）再重新打开，让新的 PATH 生效。"
  note "已打开的终端不会自动刷新 PATH；本向导内部已临时补好，不影响后续步骤。"
  pause "按回车继续。"
fi

# ── Stage 4 · 登录 GitHub ─────────────────────────────────────────────────
stage "登录 GitHub"
if [[ -z "$GH_EXE" ]]; then
  warn "gh 尚未安装，跳过登录。"
  SKIPPED+=("完成 GitHub 登录：安装 gh 后运行 gh auth login")
else
  if "$GH_EXE" auth status >/dev/null 2>&1; then
    AUTH_OK=1
    GH_USER=$("$GH_EXE" api user --jq .login 2>/dev/null || true)
    if [[ -n "$GH_USER" ]]; then
      say "检测到已登录（$GH_USER），无需重复登录。"
    else
      say "检测到已登录，无需重复登录。"
    fi
  else
    say "gh 已装好，下面完成首次 GitHub 登录；凭据由 gh 自己保存，不写入项目文件。"
    step "打开一个全新的 PowerShell 窗口（开始菜单搜索 PowerShell；不要从当前 Git Bash 启动，避免继承旧 PATH）。"
    step "在 PowerShell 中运行：gh auth login"
    note "若提示找不到 gh，改用完整路径：& \"${GH_EXE_WIN:-$GH_EXE}\" auth login"
    step "按提示选择：GitHub.com → HTTPS（或按你习惯选 SSH）→ 用浏览器登录 → 回车打开浏览器。"
    note "其余提示按默认值回车即可（包括问是否让 gh 配置 Git 凭据，选 Yes）。"
    step "复制终端显示的一次性代码，粘贴到 https://github.com/login/device ，点 Authorize。"
    open_url "https://github.com/login/device"
    note "gh 通常会自动打开同一个页面；重复打开无妨。"
    step "看到 ✓ Logged in as <账号> 后，回到本向导按回车。"
    say "小提示：若坚持在 Git Bash（MinTTY）里登录，官方建议用 winpty gh auth login，否则交互提示可能异常。"
    pause "登录完成后按回车验证。"
    login_attempts=0
    while ! "$GH_EXE" auth status >/dev/null 2>&1; do
      login_attempts=$((login_attempts + 1))
      if (( login_attempts >= 3 )); then
        warn "连续 3 次未检测到登录，先跳过；稍后运行 gh auth login 再验证。"
        SKIPPED+=("完成 GitHub 登录：运行 gh auth login，然后用 gh auth status 验证")
        break
      fi
      if confirm "还没有检测到登录状态，再试一次？"; then
        pause "完成登录后按回车重新检查。"
      else
        SKIPPED+=("完成 GitHub 登录：运行 gh auth login")
        break
      fi
    done
    if "$GH_EXE" auth status >/dev/null 2>&1; then
      AUTH_OK=1
      GH_USER=$("$GH_EXE" api user --jq .login 2>/dev/null || true)
      if [[ -n "$GH_USER" ]]; then
        say "登录成功：$GH_USER"
      else
        say "登录成功。"
      fi
    fi
  fi
fi

# ── Stage 5 · 冒烟测试与收尾 ──────────────────────────────────────────────
stage "冒烟测试与收尾"
if [[ -z "$GH_EXE" ]]; then
  warn "gh 不可用，跳过冒烟测试。"
else
  gh_ver=$(_gh_version_line "$GH_EXE" || true)
  say "版本：$gh_ver"
  if "$GH_EXE" auth status >/dev/null 2>&1; then
    AUTH_OK=1
    GH_USER=$("$GH_EXE" api user --jq .login 2>/dev/null || true)
    if [[ -n "$GH_USER" ]]; then
      say "账号：$GH_USER"
    else
      say "账号：已登录（读取用户名失败，通常是网络问题）"
    fi
    git_proto=$("$GH_EXE" config get git_protocol 2>/dev/null | tr -d '\r' || true)
    say "Git 协议：${git_proto:-未设置（登录时可选）}"
    repo_name=$("$GH_EXE" repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
    if [[ -n "$repo_name" ]]; then
      say "当前仓库可访问：$repo_name"
    fi
    step "可选：需要让 git 复用 gh 凭据时，运行 gh auth setup-git。"
  else
    warn "尚未登录；登录后可用 gh auth status / gh pr list / gh repo view。"
  fi
fi
pause "按回车收尾。"
finish

# finish 会清屏，这里展示本向导自己的结果。
if [[ -n "$GH_EXE" ]]; then
  say "gh：${GH_EXE_WIN:-$GH_EXE}"
  if (( AUTH_OK == 1 )); then
    say "账号：${GH_USER:-已登录}"
  else
    say "账号：未登录（运行 gh auth login 完成登录）"
  fi
  say "常用命令：gh auth status / gh pr list / gh repo view / gh --help"
else
  warn "gh 未完成安装；请重跑本向导或按上面的提示手动安装。"
fi
