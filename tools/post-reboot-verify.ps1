#requires -Version 7.0
<#
重启后的一键验证（WPF 可用才继续）：
1) 空 WPF 探针（确认 D3D9 恢复）
2) 若 Zilux2 未运行，用 CDP 参数启动安装目录版本
3) 等 CDP 就绪 → 跑 .scratch/verify-tail-loop-app.mjs（尾小节循环事件级验证）
4) 跑 tools/verify-multimonitor.ps1（三屏程序化移动）
5) 收集 host.log 尾部并写 docs/verification-post-reboot-<时间>.md

用法：pwsh -File tools/post-reboot-verify.ps1
      pwsh -File tools/post-reboot-verify.ps1 -SkipProbe   # 已知环境正常时跳过探针
#>
param(
    [string]$AppExe = "$env:LOCALAPPDATA\Programs\Zilux2\Zilux2.exe",
    [switch]$SkipProbe,
    [int]$CdpPort = 9223
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = Join-Path $root "docs\verification-post-reboot-$stamp.md"
$lines = [System.Collections.Generic.List[string]]::new()
function Add-Line([string]$text = '') { $lines.Add($text); Write-Host $text }
Add-Line "# 重启后验证记录 $stamp"
Add-Line ''

# 1) WPF 探针
if (-not $SkipProbe) {
    $probe = Join-Path $env:TEMP 'zilux2-wpf-probe.ps1'
    @'
Add-Type -AssemblyName PresentationFramework
$w = New-Object System.Windows.Window
$w.Width = 320; $w.Height = 200; $w.Title = 'probe'
$w.Show()
Start-Sleep -Milliseconds 1200
$w.Close()
'exit-ok'
'@ | Set-Content -Path $probe -Encoding UTF8
    & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File $probe | Out-Null
    $probeRc = $LASTEXITCODE
    Add-Line "- WPF 探针：exit=$probeRc $(if ($probeRc -eq 0) { '(可用)' } else { '(仍崩溃，需重启；0xC0000005 = -1073741819)' })"
    if ($probeRc -ne 0) {
        Add-Line ''
        Add-Line '> 环境仍不可用：WPF 空窗口都起不来，应用无需启动。请重启电脑后重跑此脚本。'
        New-Item -ItemType Directory -Force -Path (Split-Path $report) | Out-Null
        Set-Content -Path $report -Value ($lines -join "`n") -Encoding UTF8
        Write-Host "REPORT=$report"
        exit 2
    }
} else {
    Add-Line '- WPF 探针：已跳过'
}

# 2) 启动应用
$proc = Get-Process Zilux2 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) {
    if (-not (Test-Path $AppExe)) { throw "找不到应用：$AppExe" }
    $env:ZILUX2_DEV = '1'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
    $proc = Start-Process -FilePath $AppExe -PassThru
    Add-Line "- 启动应用：pid=$($proc.Id) exe=$AppExe"
} else {
    Add-Line "- 应用已在运行：pid=$($proc.Id)"
}
Start-Sleep -Seconds 2

# 3) 等 CDP
$cdpOk = $false
$deadline = (Get-Date).AddSeconds(75)
while ((Get-Date) -lt $deadline) {
    try {
        $version = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 2
        $cdpOk = $true
        break
    } catch {
        if ($proc.HasExited) { break }
        Start-Sleep -Milliseconds 800
    }
}
Add-Line "- CDP $CdpPort：$(if ($cdpOk) { 'ready' } else { 'unavailable' })"
if (-not $cdpOk) {
    Add-Line ''
    Add-Line '> CDP 未就绪；若进程已退出，请看 `%LOCALAPPDATA%\Zilux2\logs\host.log` 与事件日志。'
    $tail = Get-Content "$env:LOCALAPPDATA\Zilux2\logs\host.log" -Tail 20 -ErrorAction SilentlyContinue
    Add-Line '```'
    $lines.AddRange([string[]]$tail)
    Add-Line '```'
    New-Item -ItemType Directory -Force -Path (Split-Path $report) | Out-Null
    Set-Content -Path $report -Value ($lines -join "`n") -Encoding UTF8
    Write-Host "REPORT=$report"
    exit 3
}

# 4) 尾小节循环
Add-Line ''
Add-Line '## 尾小节循环（事件级）'
$nodeOut = Join-Path $env:TEMP "zilux2-tail-$stamp.out"
$nodeErr = Join-Path $env:TEMP "zilux2-tail-$stamp.err"
$node = Start-Process -FilePath 'node' -ArgumentList '.scratch/verify-tail-loop-app.mjs' -WorkingDirectory $root -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr -PassThru -NoNewWindow
$finished = $node.WaitForExit(120000)
if (-not $finished) { try { $node.Kill() } catch {} }
$tailOut = Get-Content $nodeOut -Raw -ErrorAction SilentlyContinue
$tailErr = Get-Content $nodeErr -Raw -ErrorAction SilentlyContinue
Add-Line "- 退出码：$($node.ExitCode)"
Add-Line '```json'
Add-Line ($tailOut.Trim())
Add-Line '```'
if ($tailErr -and $tailErr.Trim().Length -gt 0) {
    Add-Line '- stderr：'
    Add-Line '```'
    Add-Line ($tailErr.Trim())
    Add-Line '```'
}

# 5) 多屏
Add-Line ''
Add-Line '## 多屏程序化移动'
$monOut = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-multimonitor.ps1') 2>&1
Add-Line '```'
foreach ($line in $monOut) { Add-Line ([string]$line) }
Add-Line '```'

# 6) 日志尾部
Add-Line ''
Add-Line '## host.log（末尾 25 行）'
Add-Line '```'
$hostTail = Get-Content "$env:LOCALAPPDATA\Zilux2\logs\host.log" -Tail 25 -ErrorAction SilentlyContinue
foreach ($line in $hostTail) { Add-Line ([string]$line) }
Add-Line '```'

New-Item -ItemType Directory -Force -Path (Split-Path $report) | Out-Null
Set-Content -Path $report -Value ($lines -join "`n") -Encoding UTF8
Write-Host "REPORT=$report"
