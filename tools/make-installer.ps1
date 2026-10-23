param(
    [string]$Version,
    [switch]$SkipPayloadRefresh
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 版本号唯一来源：Directory.Build.props（可被 -Version 覆盖）
if (-not $Version) {
    $propsPath = Join-Path $root "Directory.Build.props"
    if (Test-Path $propsPath) {
        $match = Select-String -Path $propsPath -Pattern '<Version>([^<]+)</Version>' | Select-Object -First 1
        if ($match) { $Version = $match.Matches[0].Groups[1].Value.Trim() }
    }
    if (-not $Version) { $Version = "1.0.0" }
}
Write-Output "version: $Version"

$dotnet = "E:\dotnet\dotnet.exe"
if (-not (Test-Path $dotnet)) { $dotnet = "dotnet" }
$cliHome = "E:\aurora-toolchain\clihome"
if (-not $env:DOTNET_CLI_HOME -and (Test-Path $cliHome)) { $env:DOTNET_CLI_HOME = $cliHome }
$nugetCache = "E:\aurora-toolchain\nuget"
if (-not $env:NUGET_PACKAGES -and (Test-Path $nugetCache)) { $env:NUGET_PACKAGES = $nugetCache }

$appDir = Join-Path $root "dist\Zilux2"
$appExe = Join-Path $appDir "Zilux2.exe"
$webDir = Join-Path $appDir "web"
if (-not (Test-Path $appExe)) { throw "缺少 $appExe，请先运行 tools\publish.ps1" }

if (-not $SkipPayloadRefresh) {
    # 用最新的 web 构建覆盖发布目录，避免安装包带旧前端
    $freshWeb = Join-Path $root "web\dist"
    if (Test-Path (Join-Path $freshWeb "index.html")) {
        if (Test-Path $webDir) { Remove-Item $webDir -Recurse -Force }
        Copy-Item $freshWeb $webDir -Recurse -Force
        Write-Output "web refreshed -> dist\Zilux2\web"
    }
}

$installerDir = Join-Path $root "src\Zilux2.Installer"
$iconSource = Join-Path $root "src\Zilux2\app.ico"
$iconTarget = Join-Path $installerDir "app.ico"
Copy-Item $iconSource $iconTarget -Force

$payloadZip = Join-Path $installerDir "payload.zip"
if (Test-Path $payloadZip) { Remove-Item $payloadZip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $appDir,
    $payloadZip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)
Write-Output ("payload {0:N0} bytes" -f (Get-Item $payloadZip).Length)

$outDir = Join-Path $root "dist\installer-out"
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
& $dotnet publish (Join-Path $installerDir "Zilux2.Installer.csproj") -c Release -o $outDir `
    -p:PublishSingleFile=true -p:SelfContained=false -p:Version=$Version 2>&1 | Select-Object -Last 4

$setupProduced = Get-ChildItem $outDir -Filter "Zilux2-Setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setupProduced) { throw "发布产物里没找到 Zilux2-Setup.exe" }
$setupPath = Join-Path $root ("dist\Zilux2-Setup-$Version.exe")
Copy-Item $setupProduced.FullName $setupPath -Force
Remove-Item $payloadZip -Force
Write-Output ("setup {0} ({1:N0} bytes)" -f $setupPath, (Get-Item $setupPath).Length)
