#requires -Version 5.1
<#
    把 dist\Zilux2 的最新构建装到 %LOCALAPPDATA%\Programs\Zilux2（装机版）。
    - exe 用「先改名再拷贝」的方式替换：Windows 允许重命名正在运行的 exe，
      所以不需要先杀进程，旧进程继续活着直到用户重启。
    - web 先补新 assets（文件名带哈希，不会覆盖旧文件），再换 index.html，
      所以正在运行的窗口即使在部署中途重新加载也不会 404。
    - web\remote 与 web\fonts 是装机版自己的东西，一律不碰。
#>
param(
    [string]$Source = 'E:\Zilux2开发\dist\Zilux2',
    [string]$Target = "$env:LOCALAPPDATA\Programs\Zilux2",
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not (Test-Path (Join-Path $Source 'Zilux2.exe'))) { throw "source exe missing: $Source" }
if (-not (Test-Path (Join-Path $Target 'Zilux2.exe'))) { throw "target exe missing: $Target" }
if (-not (Test-Path (Join-Path $Source 'web\index.html'))) { throw 'source web\index.html missing' }

function Step([string]$Text) { Write-Host "· $Text" }

$running = Get-Process Zilux2 -ErrorAction SilentlyContinue
if ($running) {
    Write-Host ("note: Zilux2 正在运行（PID {0}），exe 用改名方式替换，重启后生效" -f ($running.Id -join ','))
}

# ---- 1) web：备份 → 补 assets → 换 index.html ----
$webTarget = Join-Path $Target 'web'
$webSource = Join-Path $Source 'web'
$webBak = Join-Path $Target "web.bak-$stamp"
Step "backup web -> web.bak-$stamp"
if (-not $DryRun) { Copy-Item $webTarget $webBak -Recurse -Force }

$newAssets = Get-ChildItem (Join-Path $webSource 'assets') -File
Step ("copy {0} asset file(s)" -f $newAssets.Count)
if (-not $DryRun) {
    Copy-Item (Join-Path $webSource 'assets\*') (Join-Path $webTarget 'assets') -Force
    Copy-Item (Join-Path $webSource 'index.html') (Join-Path $webTarget 'index.html') -Force
}

# 旧 bundle 已无引用：只删装机版 assets 里不在新集合中的文件。
$keep = $newAssets.Name
$stale = Get-ChildItem (Join-Path $webTarget 'assets') -File | Where-Object { $keep -notcontains $_.Name }
Step ("prune {0} stale asset(s): {1}" -f $stale.Count, ($stale.Name -join ', '))
if (-not $DryRun -and $stale) { $stale | Remove-Item -Force }

# fonts 只在源里存在时补（不删目标多出来的）。
$fontSource = Join-Path $webSource 'fonts'
if (Test-Path $fontSource) {
    Step 'sync fonts (additive)'
    if (-not $DryRun) { Copy-Item (Join-Path $fontSource '*') (Join-Path $webTarget 'fonts') -Force -ErrorAction SilentlyContinue }
}

# ---- 2) exe：改名保留旧的可执行文件，再拷新的 ----
$exeTarget = Join-Path $Target 'Zilux2.exe'
$exeBak = Join-Path $Target "Zilux2.exe.bak-$stamp"
Step "rename old exe -> Zilux2.exe.bak-$stamp"
if (-not $DryRun) { Move-Item $exeTarget $exeBak -Force }

Step 'copy new exe'
if (-not $DryRun) { Copy-Item (Join-Path $Source 'Zilux2.exe') $exeTarget -Force }

# ---- 3) 其它根目录文件（native lib 之类）按需补齐 ----
$rootFiles = Get-ChildItem $Source -File | Where-Object { $_.Name -notin @('Zilux2.exe') -and $_.Extension -ne '.cmd' }
foreach ($file in $rootFiles) {
    $dest = Join-Path $Target $file.Name
    $same = (Test-Path $dest) -and ((Get-FileHash $dest).Hash -eq (Get-FileHash $file.FullName).Hash)
    if (-not $same) {
        Step ("sync root file {0}" -f $file.Name)
        if (-not $DryRun) { Copy-Item $file.FullName $dest -Force }
    }
}

# ---- 4) 校验 ----
if (-not $DryRun) {
    $srcHash = (Get-FileHash (Join-Path $Source 'Zilux2.exe')).Hash
    $dstHash = (Get-FileHash $exeTarget).Hash
    if ($srcHash -ne $dstHash) { throw "exe hash mismatch after copy: $srcHash vs $dstHash" }
    $srcIndex = (Get-FileHash (Join-Path $webSource 'index.html')).Hash
    $dstIndex = (Get-FileHash (Join-Path $webTarget 'index.html')).Hash
    if ($srcIndex -ne $dstIndex) { throw 'index.html hash mismatch after copy' }
    $missing = $newAssets | Where-Object { -not (Test-Path (Join-Path $webTarget ('assets\' + $_.Name))) }
    if ($missing) { throw ("assets missing after copy: " + ($missing.Name -join ', ')) }
    Write-Host ''
    Write-Host ("deployed: {0}" -f $Target)
    Write-Host ("exe      {0}  {1}" -f $srcHash.Substring(0, 16), (Get-Item $exeTarget).VersionInfo.ProductVersion)
    Write-Host ("index    {0}" -f $srcIndex.Substring(0, 16))
    Write-Host ("assets   {0} 个：{1}" -f $newAssets.Count, ($newAssets.Name -join ', '))
    Write-Host ("backup   web.bak-{0} / Zilux2.exe.bak-{0}" -f $stamp)
}
