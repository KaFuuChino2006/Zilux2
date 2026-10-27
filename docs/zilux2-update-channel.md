# Zilux2 更新通道（GitHub Releases）

更新通道从 v1.0.0 起启用：宿主定期向 GitHub 查询最新 Release，发现新版本后可下载安装包、校验并静默安装，装完自动重启。

- 发布源：GitHub Releases（`https://api.github.com/repos/<owner>/<repo>/releases/latest`）
- 安装包命名：`Zilux2-Setup-<version>.exe`（由 `tools/make-installer.ps1` 产出）
- 默认行为：自动检查 + 后台下载 + 提示「立即安装并重启」；设置里可切到「仅提示」

## 1. 版本号唯一来源

版本号只写在一个地方：仓库根目录 `Directory.Build.props`

```xml
<Project>
  <PropertyGroup>
    <Version>1.0.0</Version>
    <ZiluxUpdateRepo Condition="'$(ZiluxUpdateRepo)' == ''">KaFuuChino2006/Zilux2</ZiluxUpdateRepo>
  </PropertyGroup>
</Project>
```

- 宿主 `src/Zilux2` 与安装器 `src/Zilux2.Installer` 都继承这个版本号（两个 csproj 里不再写 `<Version>`）。
- `ZiluxUpdateRepo` 是编译期注入的默认更新源，格式 `owner/repo`；CI 会用 `-p:ZiluxUpdateRepo=${{ github.repository }}` 覆盖，本地构建时用占位值。宿主通过程序集元数据 `ZiluxUpdateRepo` 读回。
- Git tag 与版本号一致：`v1.0.0` ↔ `1.0.0`。发版只改 `Directory.Build.props` 的 `<Version>`，提交后打 tag 推送。
- 设置里 `updates.repo`（`owner/repo`）可覆盖编译期默认值，空字符串表示用默认值（便于在仓库建好前测试别的仓库）。

## 2. Release 资产

每份 Release 至少包含一个安装包资产：

- `Zilux2-Setup-<version>.exe`：自包含更新用的单文件安装器，支持 `--silent --no-shortcuts --launch --dir <dir>`。
- 可选：`Zilux2-Setup-<version>.exe.sha256`（不强制，GitHub API 的 `assets[].digest` 优先）。
- Release 正文（body）即更新日志，宿主会原样展示在「设置 → 更新」里；只写本版本真实改动与修复，不写项目介绍、资产表、发版/仓库说明等模板信息（资产在 Release 附件列表里可见，说明见交接文档）。项目约定。

宿主选资产规则：优先 `Zilux2-Setup-<latestVersion>.exe`，否则第一个匹配 `Zilux2-Setup-*.exe` 的资产。没有可用 exe 资产时进入 `unavailable` 状态（仍可打开 Release 页）。

## 3. 宿主行为

`UpdateService`（`src/Zilux2/Updates/UpdateService.cs`）负责全部逻辑：

1. **检查**：`GET https://api.github.com/repos/{owner}/{repo}/releases/latest`
   - Header：`Accept: application/vnd.github+json`、`User-Agent: Zilux2-Updater`、`X-GitHub-Api-Version: 2022-11-28`
   - 超时 15s；未认证限流 60 次/小时，因此检查有节流：同一进程内 60s 内不重复请求（手动强制检查除外）。
   - 启动后约 8s 自动检查一次（`updates.autoCheck=true` 时），之后每 4 小时一次；页面发送 `check` 可随时手动检查。
2. **比较版本**：`tag_name` 去掉前缀 `v`，按数字段逐段比较（`1.0.10 > 1.0.9`）；`releases/latest` 已排除草稿与预发布。
3. **下载**：`auto` 模式下发现新版本立即后台下载；`notify` 模式不自动下载，由用户点按钮下载。
   - 保存到 `%LOCALAPPDATA%\Zilux2\updates\<assetName>`；同名文件已存在时先删。
   - 下载用 `browser_download_url`，流式写入，进度节流到约 200ms 一次。
   - 若资产带 `digest`（`sha256:<hex>`）则下载完必须校验，不一致删除文件并报错；没有 digest 时仅校验大小（记录警告）。
4. **安装**：校验通过后启动安装器：
   ```
   Zilux2-Setup-<version>.exe --silent --no-shortcuts --launch --dir <installDir>
   ```
   - `installDir` 优先读注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Zilux2` 的 `InstallLocation`，不存在则用默认安装目录 `%LOCALAPPDATA%\Programs\Zilux2`。
   - `--launch` 让安装器装完自动启动新版本；宿主启动安装器后自行退出（安装器会先杀掉正在运行的 Zilux2）。
5. **取消**：`cancel` 中止进行中的下载。

> 更新包未做代码签名，校验依赖 HTTPS（GitHub API + `digest`）。后续如签名，可在安装前加 Authenticode 校验。

## 4. 消息协议（v1）

页面 → 宿主：

```json
{ "v": 1, "type": "update", "action": "check" }
```

`action` 取值：

| action | 说明 |
| --- | --- |
| `check` | 检查更新（可选 `force: true` 跳过 60s 节流） |
| `download` | 下载当前发现的新版本安装包 |
| `install` | 对已下载并通过校验的安装包执行静默安装并重启 |
| `cancel` | 取消下载 |
| `openReleasePage` | 用系统浏览器打开最新 Release 页面（无 Release 时打开 releases 列表） |

宿主 → 页面（每次状态变化推送完整快照，`type:"host"`, `event:"update"`）：

```json
{
  "v": 1,
  "type": "host",
  "event": "update",
  "state": "idle",
  "currentVersion": "1.0.0",
  "latestVersion": null,
  "releaseName": null,
  "notes": null,
  "pageUrl": null,
  "assetName": null,
  "assetSize": 0,
  "downloaded": 0,
  "total": 0,
  "error": null,
  "notice": null,
  "mode": "auto",
  "autoCheck": true,
  "repo": "owner/repo",
  "canAutoInstall": false,
  "checkedAt": null
}
```

字段说明：

- `state`：`idle`（未检查）| `checking` | `up-to-date` | `available` | `downloading` | `downloaded` | `installing` | `error` | `unavailable`
  - `unavailable`：检查成功但通道没有可用版本（仓库无 Release / 无 Windows 安装包资产），`notice` 说明原因，`latestVersion` 可能为空。
- `currentVersion`：宿主程序集版本（如 `1.0.0`）。
- `latestVersion`：最新 Release 版本号（无 `v` 前缀）。
- `releaseName` / `notes`：Release 名称与正文（Markdown 原文，前端以纯文本展示）。
- `pageUrl`：Release 页面 URL。
- `assetName` / `assetSize`：选中的安装包名称/字节数。
- `downloaded` / `total`：下载进度（`downloading` 时有效）。
- `error`：`error` 状态下的可读错误信息。
- `notice`：`unavailable` 等状态的补充说明。
- `mode` / `autoCheck` / `repo`：当前生效的设置值，供页面展示。
- `canAutoInstall`：是否具备自动安装条件（有可下载资产）。
- `checkedAt`：最近一次检查的 UTC 时间（ISO 8601）。

页面 `ready` 后宿主立即推送一次当前快照；此后任何状态变化都推送。

## 5. 设置字段

设置快照末尾新增一段（契约见 `docs/zilux2-settings-contract.md`）：

```json
"updates": { "autoCheck": true, "mode": "auto", "repo": "" }
```

- `autoCheck`：启动时自动检查 + 每 4 小时轮询。
- `mode`：`auto` = 自动下载并在下载完成后提示安装；`notify` = 只提示新版本与 Release 页。
- `repo`：`owner/repo` 覆盖更新源；空字符串用编译期默认值。

## 6. 前端行为

- 设置页新增「更新」分区：当前版本、检查按钮、状态文案、下载进度条、更新日志、安装按钮、自动检查开关、更新方式、更新源输入框、打开 Release 页。
- `auto` 模式：宿主检查到新版本会自动下载；下载完成（`downloaded`）时前端弹一次确认框「新版本 vX 已就绪，立即安装并重启？」，确认后发 `install`。
- `notify` 模式：`available` 时 toast 提示「发现新版本 vX」，并引导到设置页查看/打开 Release 页。
- 无宿主（浏览器预览）时更新模块静默降级，不报错。

## 7. 发布流程（GitHub Actions）

> **发版节奏约定**：累计修复 / 优化超过 5 处，或新增功能累计 3 个以上，才递增 patch 版本并发 Release；不足门槛时只提交推送 `main`，不改版本、不打 tag。


`.github/workflows/release.yml`：

1. 触发：推送 `v*` tag，或手动 `workflow_dispatch`（输入版本号）。
2. `windows-latest`：安装 .NET 10、Node 22、pnpm → `pnpm install --frozen-lockfile` → `pnpm run build`（web）。
3. `tools/publish.ps1 -SkipWebBuild -Version <ver> -UpdateRepo <owner/repo>` 发布宿主到 `dist/Zilux2`。
4. `tools/make-installer.ps1 -Version <ver>` 产出 `dist/Zilux2-Setup-<ver>.exe`。
5. 准备 Release 更新日志：优先用仓库内 `docs/release-notes/v<ver>.md`；没有则按上一个 tag 到本次的提交自动生成（过滤 docs/chore/ci/test/style/build 等非可见改动）。正文只写可见的真实改动与修复，不要放资产表、项目介绍、发版说明。
6. 创建 GitHub Release（由 tag 触发时）并上传安装包，正文即上一步的更新日志。

本地发版：`powershell -File tools/release.ps1`（构建 + 出安装包 + 打 tag，见脚本帮助）。

## 8. 手工验证

1. 构建并安装: `tools\publish.ps1` → `tools\make-installer.ps1 -Version 1.0.0` → `dist\Zilux2-Setup-1.0.0.exe --silent --no-shortcuts`。
2. 造一个更高的 Release（例如在测试仓库发 `v1.0.1`），把设置 `updates.repo` 指向该仓库（或直接改 `settings.json`），重启应用。
3. 打开「设置 → 更新」，应看到新版本、更新日志，auto 模式自动下载；点「立即安装并重启」后应静默升级到 1.0.1。
4. 失败路径：断网 / 仓库不存在 / 无 Release 资产 / hash 不符，均应在状态区给出可读错误。

## 9. 仓库可见性（public / private）

应用内更新直接请求未认证的 GitHub REST API，因此**只有公开仓库的 Release 可见**：

- 私有仓库：`GET /repos/<owner>/<repo>/releases/latest` 返回 404，客户端显示「未找到可用版本：仓库不存在、未公开，或还没发布 Release」。代码与 CI 可以照常用，只是客户端检查不到更新。
- 推荐做法：开发期用 private 仓库只存代码；准备对外发布时，仓库 Settings → 最下方 Danger Zone → Change repository visibility → Public，再推 `v<version>` tag 触发 Actions 出 Release。
- 私有仓库若确实要做应用内更新，需要自建带 token 的中转服务（token 不能随客户端分发）；当前实现不支持，也不建议把 PAT 写进客户端。
- 手动检查更新不需要登录，不受用户 GitHub 登录状态影响。
