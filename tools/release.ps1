#Requires -Version 5.1
<#
.SYNOPSIS
    本地一键发布 Zilux2：构建 -> 打安装包 -> 可选打 tag 并推送（推送后由 GitHub Actions 发布 Release）。

.DESCRIPTION
    CI（.github/workflows/release.yml）才是权威发布路径，本脚本是等价的本地流程，便于
    发版前在本机确认产物，或临时绕过 CI 手动发布：
      1) tools\publish.ps1        默认会先构建前端（web\dist），再 dotnet publish 到 dist\Zilux2
      2) tools\make-installer.ps1 生成 dist\Zilux2-Setup-<version>.exe（应用内更新按这个文件名匹配）
      3) 可选：git tag v<version> / git push origin v<version>，随后 CI 自动创建 Release

    版本号唯一来源是仓库根 Directory.Build.props 的 <Version>，可用 -Version 覆盖。

.PARAMETER Version
    版本号，如 1.0.1 或 v1.0.1；省略时读取 Directory.Build.props。

.PARAMETER SkipBuild
    跳过 web 前端构建（要求 web\dist 已存在），透传给 publish.ps1 -SkipWebBuild。

.PARAMETER Tag
    构建成功后创建本地 annotated tag v<version>。已存在同名 tag 时会报错退出。

.PARAMETER Push
    创建（或确认已存在）tag 后 push 到 origin，触发 CI 发布 Release。

.PARAMETER DryRun
    只打印将要执行的命令，不构建、不写文件、不打 tag、不推送。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -Version 1.0.1 -Tag -Push

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -SkipBuild -DryRun
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipBuild,
    [switch]$Tag,
    [switch]$Push,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Plan([string]$Text) {
    Write-Host "    $Text" -ForegroundColor DarkGray
}

# ---- 0) 解析版本号（唯一来源：Directory.Build.props） ----
if (-not $Version) {
    $propsPath = Join-Path $root 'Directory.Build.props'
    if (Test-Path $propsPath) {
        $match = Select-String -Path $propsPath -Pattern '<Version>([^<]+)</Version>' | Select-Object -First 1
        if ($match) { $Version = $match.Matches[0].Groups[1].Value.Trim() }
    }
    if (-not $Version) { throw '无法确定版本号：Directory.Build.props 里没有 <Version>，请用 -Version 指定。' }
}
$Version = $Version.Trim().TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$') {
    throw "版本号格式不合法：'$Version'；应为 1.2.3 或 v1.2.3（可带 -beta.1 这类后缀）。"
}

$tagName = "v$Version"
$publishScript = Join-Path $PSScriptRoot 'publish.ps1'
$installerScript = Join-Path $PSScriptRoot 'make-installer.ps1'
$setupPath = Join-Path $root ("dist\Zilux2-Setup-$Version.exe")

Write-Host "Zilux2 release：版本 $Version（tag 约定 $tagName）" -ForegroundColor Green

# ---- DryRun：只打印计划 ----
if ($DryRun) {
    Write-Step 'DryRun：以下命令会被执行（本次未实际运行）'
    Write-Plan "powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Version $Version$(if ($SkipBuild) { ' -SkipWebBuild' } else { '' })"
    Write-Plan "powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-installer.ps1 -Version $Version"
    if ($Tag) { Write-Plan "git tag -a $tagName -m `"Zilux2 $Version`"" }
    if ($Push) { Write-Plan "git push origin $tagName" }
    Write-Host ''
    Write-Host 'DryRun 结束：未修改任何文件。' -ForegroundColor Yellow
    return
}

# ---- 1) 构建 + 发布到 dist\Zilux2 ----
Write-Step '步骤 1/2：构建并发布宿主程序（tools\publish.ps1）'
$publishArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $publishScript, '-Version', $Version)
if ($SkipBuild) {
    $publishArgs += '-SkipWebBuild'
    Write-Host '已指定 -SkipBuild：跳过 web 前端构建，直接打包现有 web\dist。' -ForegroundColor Yellow
}
& powershell @publishArgs
if ($LASTEXITCODE -ne 0) { throw "tools\publish.ps1 失败（退出码 $LASTEXITCODE）。" }

# ---- 2) 打安装包 ----
Write-Step '步骤 2/2：生成安装包（tools\make-installer.ps1）'
& powershell -NoProfile -ExecutionPolicy Bypass -File $installerScript -Version $Version
if ($LASTEXITCODE -ne 0) { throw "tools\make-installer.ps1 失败（退出码 $LASTEXITCODE）。" }

if (-not (Test-Path $setupPath)) { throw "构建结束但找不到安装包：$setupPath" }
$setupItem = Get-Item $setupPath
$sizeMb = [math]::Round($setupItem.Length / 1MB, 1)
Write-Host ("安装包：{0}（{1} MB）" -f $setupPath, $sizeMb) -ForegroundColor Green
Write-Host ("SHA256：{0}" -f (Get-FileHash $setupPath -Algorithm SHA256).Hash.ToLowerInvariant())

# ---- 3) 可选：打 tag / 推送触发 CI ----
if ($Tag -or $Push) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw '找不到 git 命令；请先安装 Git 并确保 git 在 PATH 里。' }

    $existingTag = git tag --list $tagName
    if ($LASTEXITCODE -ne 0) { throw 'git tag 执行失败，请确认当前目录是 git 仓库。' }

    if ($Tag) {
        if ($existingTag) {
            throw "本地已存在 tag $tagName。如需重发，请先删除：git tag -d $tagName（远端 tag 需在网页上删 Release 后再 git push origin :$tagName）。"
        }
        git tag -a $tagName -m "Zilux2 $Version"
        if ($LASTEXITCODE -ne 0) { throw "git tag $tagName 失败（检查 git user.name / user.email 是否已配置）。" }
        Write-Host "已创建本地 tag $tagName。" -ForegroundColor Green
    } elseif (-not $existingTag) {
        throw "本地没有 tag $tagName，无法 -Push；请加 -Tag 一起创建，或先手动 git tag $tagName。"
    }

    if ($Push) {
        $remote = git remote get-url origin 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $remote) {
            throw '没有配置 origin 远程仓库；先执行：git remote add origin https://github.com/<owner>/Zilux2.git'
        }
        git push origin $tagName
        if ($LASTEXITCODE -ne 0) { throw "git push origin $tagName 失败（检查网络与 GitHub 凭据）。" }
        Write-Host "已推送 tag $tagName：GitHub Actions 将自动构建并发布 Release。" -ForegroundColor Green
        Write-Host '进度：仓库页面 -> Actions -> Release 工作流；发布完成后到 Releases 检查资产。'
        return
    }
}

Write-Step '完成'
Write-Host '本地产物已就绪，下一步二选一：'
Write-Host "  · 自动发布（推荐）：git push origin main; git tag -a $tagName -m `"Zilux2 $Version`"; git push origin $tagName"
Write-Host "  · 手动发布：把 $setupPath 上传到 GitHub Release（资产名不要改，见 docs/zilux2-update-channel.md §2）"
Write-Host '首次建仓/配置/发版全流程见 docs/zilux2-github-setup.md。'
