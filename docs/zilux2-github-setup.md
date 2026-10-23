# Zilux2：从零建 GitHub 仓库并发布第一个版本

本文面向 **仓库还没建、机器上没有 `gh` CLI、git 还没配过 `user.name` / `user.email`** 的情况。
照着从上往下复制粘贴即可，全程只需要浏览器 + 命令行 git，不需要 `gh`。

> 相关文档
> - 更新通道协议、版本号与资产命名约定：`docs/zilux2-update-channel.md`（**权威文档**，先读 §1/§2/§7）
> - 本地等价发布脚本：`tools/release.ps1`
> - CI 工作流：`.github/workflows/release.yml`

约定几个占位符，替换成你自己的值（注意大小写不敏感，但建议与 GitHub 上完全一致）：

| 占位符 | 含义 | 示例 |
| --- | --- | --- |
| `<owner>` | GitHub 用户名或组织名 | `xhzrrr` |
| `<repo>` | 仓库名，本项目固定叫 `Zilux2` | `Zilux2` |
| `<version>` | 版本号，来自根 `Directory.Build.props` 的 `<Version>` | `1.0.0` |
| `<tag>` | `v` + 版本号 | `v1.0.0` |

下面命令默认在仓库根目录执行（本项目是 `E:\Zilux2开发`）：

```powershell
cd E:\Zilux2开发
```

---

## 0. 开始前检查

```powershell
git --version        # 需要 2.28+（git init -b main 需要）
dotnet --version     # 需要 .NET 10 SDK（本机 CI 用 10.0.x；本地构建也需要）
node --version       # 需要 Node 22（只在本地构建前端时需要，CI 会自动装）
```

本地完整构建 + 打安装包还需要 pnpm 9，并且 `tools/publish.ps1` 会优先找
`E:\dotnet\dotnet.exe`、其次找 PATH 上的 `dotnet`；找不到就装 .NET 10 SDK 并确保 `dotnet` 在 PATH。

> 只靠 GitHub Actions 发版的话，本地**不需要** .NET / Node / pnpm —— 但首次提交、打 tag、push 需要 git。

---

## 1. 在 GitHub 网页上创建空仓库

1. 浏览器打开 <https://github.com/new>。
2. **Repository name** 填 `Zilux2`；**Owner** 选你自己的账号（或组织）。
3. **Description** 随意（例如 `Zilux2 - Windows desktop music player`）。
4. 可见性：
   - `Public`：**推荐**。应用内更新走未认证的 GitHub Releases API，私有仓库会 404，
     除非用户在设置里另外配置 —— 简单起见用公开仓库。
   - `Private`：CI 仍能构建，但已安装的客户端默认检查不到更新（见 §9）。
5. **不要**勾选 `Add a README file`、`Add .gitignore`、`Choose a license`。
   仓库里已经有 `README.md` 和 `.gitignore`，勾了会在首次 push 时冲突，多一步 rebase。
6. 点 **Create repository**。

创建完页面会显示仓库地址，记下来：

```
https://github.com/<owner>/Zilux2.git
```

### 如果暂时只建私有仓库

完全可以：私有仓库照样能 push 代码、看 Actions 日志，只是**客户端检查不到更新**（未认证 API 对私有仓库返回 404）。

1. §1 的步骤 4 选 `Private`，其余不变。
2. 正常 `git remote add` + `git push -u origin main`，**先不要推 tag**（tag 会触发 Release；私仓发布对应用内更新没有意义，还占 Actions 分钟）。
3. 本地 tag 保留即可。将来要公开发布：仓库 Settings → 最下方 Danger Zone → **Change repository visibility** → `Public`，再 `git push origin v1.0.0`（或 `tools\release.ps1 -Push`）。

---

## 2. 配置 git 身份（只需一次）

首次用 git 必须先配 `user.name` / `user.email`，否则 `git commit` / `git tag -a` 会直接失败。

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的GitHub邮箱@example.com"
```

- `user.email` 建议用 GitHub 账号里已验证的邮箱（GitHub 个人设置 → Emails 可查）；
  不想暴露真实邮箱可以用 GitHub 提供的 `12345678+用户名@users.noreply.github.com`。
- 只对当前仓库生效就去掉 `--global`。

可选（Git for Windows 通常自带凭据管理器，HTTPS push 时会弹浏览器登录）：

```powershell
git config --global credential.helper manager
```

---

## 3. 初始化本地仓库并做首次提交

```powershell
cd E:\Zilux2开发
git init -b main
```

### 3.1 先确认不会把大文件 / 私密文件提交进去

`.gitignore` 已经忽略 `research/` 下的截图、临时目录、`*.tar.gz`、`mac/` 构建缓存、
`.tmp-edge/`、`aurora-toolchainclihome/`、`dist/`、`web/node_modules` 等。提交前检查一遍：

```powershell
# 1) 看有多少文件待提交（几千个是正常的）
(git status --short | Measure-Object).Count

# 2) 抽检几个路径确实被忽略（有输出 = 已忽略）
git check-ignore -v research/mineradio.tar.gz research/shots .tmp-edge aurora-toolchainclihome web/node_modules dist

# 3) 暂存后检查有没有超过 50MB 的文件（GitHub 单文件上限 100MB，超了 push 会失败）
git add -A
git ls-files | ForEach-Object {
    $f = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue
    if ($f -and $f.Length -gt 50MB) { "{0,8:N1} MB  {1}" -f ($f.Length / 1MB), $_ }
}
```

第 3 步应当**没有输出**。如果输出了大文件，说明 `.gitignore` 规则没覆盖到它，
把路径补进 `.gitignore` 后重新 `git add -A`。

> 误把大文件 `git add` 进去了但还没提交：`git rm --cached <路径>` 再重新检查。
> 已经提交了：改完 `.gitignore` 后 `git rm --cached <路径>` 再 `git commit --amend`。

### 3.2 提交

```powershell
git add -A
git status --short        # 最后看一眼，确认没有 kugou_cookies.json / vkey.json 之类的文件
git commit -m "Initial commit: Zilux2 desktop music player"
```

首次提交文件较多（几千个），耗一两分钟属正常。

---

## 4. 关联远程仓库并推送

### 4.1 HTTPS（最简单）

```powershell
git remote add origin https://github.com/<owner>/Zilux2.git
git remote -v                                  # 确认 origin 指向自己的仓库
git branch -M main
git push -u origin main
```

首次 push 会要求登录：

- 弹浏览器（Git Credential Manager）：直接点登录即可；
- 命令行提示 `Username` / `Password`：`Username` 填 GitHub 用户名，`Password` **不能填账号密码**，
  要填 Personal Access Token：
  1. <https://github.com/settings/tokens> → **Generate new token (classic)**；
  2. 勾选 `repo`（公开仓库至少需要 `public_repo`，建议直接 `repo`）；
  3. 生成后复制 token 当密码用一次，凭据管理器会记住。

### 4.2 SSH（可选，配一次以后免密）

```powershell
ssh-keygen -t ed25519 -C "你的GitHub邮箱@example.com"   # 一路回车
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub         # 复制输出
```

把公钥粘到 <https://github.com/settings/keys> → **New SSH key**，然后：

```powershell
git remote add origin git@github.com:<owner>/Zilux2.git
git push -u origin main
```

### 4.3 本机当前的实际配置：SSH over 443（HTTPS 被网络阻断）

`KaFuuChino2006/Zilux2` 已建好并完成首次推送（**private**，只推了 `main`，tag `v1.0.0` 仍只在本地，
未触发 Actions/Release）。本机到 `github.com:443`（HTTPS）会连接重置/超时，但 `api.github.com` 与
`ssh.github.com:443` 可用，因此 `origin` 走 **SSH over 443**：

```text
ssh://git@ssh.github.com:443/KaFuuChino2006/Zilux2.git
```

仓库本地已写入（`core.sshCommand`，路径必须用正斜杠，否则 git 会吞掉反斜杠）：

```powershell
git config core.sshCommand "ssh -i C:/Users/13329/.ssh/zilux2_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=C:/Users/13329/.ssh/known_hosts_zilux2 -p 443"
```

密钥文件 `C:\Users\13329\.ssh\zilux2_deploy`（对应仓库 Settings → Deploy keys 里的 `zilux2-push`，
有写权限）。以后在这台机器上 `git push` / `git pull` 可直接用。
> 换机器：重新生成密钥，把公钥加到仓库 Deploy keys（或用自己的账号 SSH key），再
> `git remote set-url origin ssh://git@ssh.github.com:443/<owner>/<repo>.git`。

---

## 5. 发布第一个版本：打 tag，让 CI 自动构建 Release

### 5.1 确认版本号

发版版本号**只有一个来源**：仓库根 `Directory.Build.props` 的 `<Version>`。

```powershell
Select-String -Path Directory.Build.props -Pattern '<Version>'
```

当前是 `1.1.3`，对应 tag `v1.1.3`。**tag 去掉 `v` 必须等于 `<Version>`**，
否则 CI 会在「解析并校验版本号」步骤直接失败（这是故意加的 fail-fast）。

> **发版节奏约定**：累计修复 / 优化超过 5 处，或新增功能累计 3 个以上，才递增 patch 版本并发 Release；不足门槛时只提交推送 `main`，不改版本、不打 tag。

### 5.2 打 tag 并推送

> 仓库还是 **private** 的话先跳过本节（见 §1「如果暂时只建私有仓库」）；切成 public 后再回来推 tag。

```powershell
git tag -a v1.0.0 -m "Zilux2 1.0.0"
git push origin v1.0.0
```

推送 tag 就会触发 `.github/workflows/release.yml`：windows-latest 上装 .NET 10 / Node 22 / pnpm 9
→ 构建前端 → `tools/publish.ps1 -Version 1.0.0 -UpdateRepo <owner>/Zilux2`（由 CI 注入实际仓库名）
→ `tools/make-installer.ps1 -Version 1.0.0` → 创建 GitHub Release。

**不用 gh CLI**：也可以在网页 Actions 页面手动跑：
仓库 → **Actions** → 左侧 **Release** → **Run workflow** → `version` 填 `1.0.0`（留空则用当前 tag）→ Run。
注意手动触发时，被触发分支上的 `Directory.Build.props` 版本号也必须与填写的版本一致。

### 5.3 检查结果

1. 仓库 → **Actions** → **Release**：等最新一次运行变绿（约 5–10 分钟，首次 restore 较慢）。
   失败时点进运行看红叉步骤的日志，常见原因见 §9。
2. 仓库 → **Releases**：应有 `Zilux2 v1.0.0`，资产三件套：
   - `Zilux2-Setup-1.0.0.exe` ← **应用内更新认的就是这个文件名，不要改**
   - `Zilux2-Setup-1.0.0.exe.sha256`
   - `Zilux2-Portable-1.0.0.zip`（便携版，解压即用）
3. 如果 Release 页面没有资产或只有 `.zip`：回看 Actions 日志里 `tools/make-installer.ps1` 的输出。

---

## 6. 更新源（默认 `KaFuuChino2006/Zilux2`）

编译期默认更新源是 `KaFuuChino2006/Zilux2`（见根 `Directory.Build.props` 的
`<ZiluxUpdateRepo>`，协议见 `docs/zilux2-update-channel.md` §1）。仓库改名或换 owner 时有**两种**改法，推荐 A。

### 方式 A（推荐）：CI 自动注入 `github.repository`

`release.yml` 里发布宿主程序那一步是：

```powershell
powershell -NoProfile -File tools/publish.ps1 -SkipWebBuild -Version $ver -UpdateRepo ${{ github.repository }}
```

`${{ github.repository }}` 会被 GitHub 替换成实际的 `owner/repo`（例如 `xhzrrr/Zilux2`），
再通过 `-p:ZiluxUpdateRepo=...` 编译进 exe。**从 Releases 下载的安装包、由它安装出来的客户端
自动指向你的仓库，什么都不用改。**

注意：
- **本地构建**的包不会自动带这个参数。要本地构建一个「指向自己仓库」的包，显式传：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Version 1.0.0 -UpdateRepo <owner>/Zilux2
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-installer.ps1 -Version 1.0.0
  ```
- 本地默认构建已指向 `KaFuuChino2006/Zilux2`；仓库改名后同步改 `Directory.Build.props` 的
  `<ZiluxUpdateRepo>` 即可。

### 方式 B：用户在设置里覆盖 `updates.repo`

客户端 设置 → **更新** → 「仓库」输入框，填 `owner/repo`（例如 `<owner>/Zilux2`），保存后重启生效。
持久化键是 `updates.repo`，留空 = 回退到编译期默认值。
适合：仓库 owner 改了、想临时指向测试仓库、或者本地构建的占位包想连真实仓库。
⚠️ 只认 `owner/repo` 格式，不能带 `https://github.com/` 前缀。

> 两者同时存在时，设置里的 `updates.repo` 优先。

---

## 7. 第一次自动更新自测（端到端）

以已安装 `1.0.0`、准备发布 `1.0.1` 为例：

1. 用 1.0.0 的安装包装好（`Zilux2-Setup-1.0.0.exe`），启动一次确认能运行。
   > 未签名的安装包/exe 首次运行会有 SmartScreen「更多信息 → 仍要运行」，正常。
2. 改版本号：把 `Directory.Build.props` 的 `<Version>1.0.0</Version>` 改成 `1.0.1`。
3. 提交并推送**代码**，再打 tag 推送：
   ```powershell
   git add -A
   git commit -m "Release 1.0.1"
   git push origin main
   git tag -a v1.0.1 -m "Zilux2 1.0.1"
   git push origin v1.0.1
   ```
   只推 tag 不推 commit 的话，Release 指向的代码里 `Directory.Build.props` 还是 1.0.0，CI 会失败。
4. 等 Actions 绿了、Release `Zilux2 v1.0.1` 出来，资产名是 `Zilux2-Setup-1.0.1.exe`。
5. 打开**已安装的 1.0.0**：
   - 设置 → 更新 → 点「检查更新」，或等启动约 8 秒后的自动检查；
   - 应显示 `1.0.1` 的新版本、更新说明（Release body）和「下载/安装」按钮；
   - 下载完成点安装 → 应用退出 → 静默安装 → 自动启动新版本；
   - 设置 → 关于 或更新分区应显示当前版本 `1.0.1`。
6. 如果只显示「已是最新」/「不可用」：对照 §9 排查（最常见是仓库私有、或 exe 资产名不对）。

本地想先验证构建流程（不推 tag）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -Version 1.0.1 -DryRun   # 只看计划
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -Version 1.0.1           # 真构建
powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -Version 1.0.1 -Tag -Push # 构建 + 打 tag + 推送
```

---

## 8. 日常发版清单（TL;DR）

0. 确认已达到发版门槛（修复/优化累计 >5 处，或新功能累计 ≥3 个）；否则只提交推送，不发版；
1. 改 `Directory.Build.props` → `<Version>X.Y.Z</Version>`；
2. 提交并推 `main`；
3. `git tag -a vX.Y.Z -m "Zilux2 X.Y.Z"`；
4. `git push origin vX.Y.Z`；
5. 等 Actions 绿 → Releases 里检查 `Zilux2-Setup-X.Y.Z.exe`；
6. 老版本客户端启动后会自动提示更新。

---

## 9. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| Actions 在「解析并校验版本号」失败，报「版本号不一致」 | tag 去掉 `v` 后不等于 `Directory.Build.props` 的 `<Version>`。改 props 后重推：`git push origin :v1.0.1` 删远端 tag、`git tag -d v1.0.1` 删本地，再重新打。 |
| Actions 在 `pnpm install --frozen-lockfile` 失败 | `web/pnpm-lock.yaml` 与 `web/package.json` 不同步。本地 `cd web; pnpm install`（不要加 `--frozen-lockfile`）后把更新过的 lockfile 一起提交。 |
| `dotnet publish` / `make-installer` 失败 | 看日志里 dotnet 的具体错误；CI 上 `E:\dotnet` 和 `E:\aurora-toolchain` 不存在，脚本会自动退回 PATH 上的 dotnet（已处理）。 |
| Release 建出来了但没有 exe 资产 | 检查 `tools/make-installer.ps1` 是否输出了 `dist\Zilux2-Setup-X.Y.Z.exe`；`files:` 里 `fail_on_unmatched_files: true` 会让缺文件时直接失败。 |
| Actions 报 403 / `Resource not accessible by integration` | 仓库 Settings → Actions → General → Workflow permissions 选 **Read and write permissions**；`release.yml` 里已声明 `permissions: contents: write`。 |
| 客户端更新「检查失败 / 不可用」 | ①仓库是私有 → 自动更新不可用（未认证 API 404），改公开或改用设置 `updates.repo` 指向公开仓库；②exe 资产名不是 `Zilux2-Setup-<version>.exe`；③GitHub API 限流（未认证 60 次/小时，等一会儿）。 |
| 私有仓库能不能用自动更新 | 不能。应用内更新走未认证 API，私有仓库一律 404；代码可正常 push、CI 可正常跑，等仓库切 public 并发布 Release 后客户端才能检查到更新。 |
| SmartScreen 拦截 | 安装包未做代码签名，属预期；点「更多信息 → 仍要运行」。 |
| 想重发同一个版本 | 先删 GitHub Release（Releases → 对应 Release → Delete），再删远端 tag：`git push origin :v1.0.1`，删本地 tag `git tag -d v1.0.1`，然后重新打 tag 推送。 |
| 首次 push 很慢 / 文件很多 | 仓库里包含前端、宿主源码和文档属正常（几千个文件、几十 MB）；如果发现 push 体积远超 100MB，回 §3.1 检查大文件是否被忽略。 |

---

## 10. 手动发布兜底（CI 不可用时）

构建产物在 `dist\` 下：

- `dist\Zilux2\` —— 便携版目录；
- `dist\Zilux2-Setup-<version>.exe` —— 安装包。

手动发布步骤：仓库 → **Releases** → **Draft a new release** → 选择/新建 tag `v<version>`
→ 标题填 `Zilux2 <version>` → 说明里写明更新内容（客户端会原样展示）→ 上传
`Zilux2-Setup-<version>.exe`（**文件名不能改**）→ **Publish release**。

> 不支持 `gh` 也完全没问题：以上就是纯网页操作。
