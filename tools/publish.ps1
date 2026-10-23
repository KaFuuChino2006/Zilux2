#Requires -Version 5.1
<#
.SYNOPSIS
    Publishes Zilux2 as a ready-to-run portable app under dist\Zilux2.
.DESCRIPTION
    - Builds the web front end (web\dist) unless -SkipWebBuild.
    - Runs dotnet publish (single file, framework-dependent by default).
    - Copies the front end next to the exe as web\ (the host loads <exe>\web).
    - Writes a tiny launcher cmd into the output folder.
    Framework-dependent needs the .NET 10 Desktop Runtime (the SDK machine already has it).
    Use -SelfContained for a fully standalone folder (bigger).
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release',

    [string]$OutputDirectory,

    [switch]$SelfContained,
    [switch]$SkipWebBuild,
    [switch]$SkipRestore,

    # 版本号与更新仓库来源：默认取根目录 Directory.Build.props，CI 用 -Version/-UpdateRepo 覆盖。
    [string]$Version,
    [string]$UpdateRepo
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'src\Zilux2\Zilux2.csproj'
$webDir = Join-Path $repoRoot 'web'
$webDist = Join-Path $webDir 'dist'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist\Zilux2' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$offlineSource = 'E:\aurora-toolchain\nuget'
if ($offlineSource -and -not (Test-Path $offlineSource)) { $offlineSource = $null }

function Resolve-Dotnet {
    $candidates = @('E:\dotnet\dotnet.exe')
    $onPath = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    throw 'dotnet executable not found: expected E:\dotnet\dotnet.exe or dotnet on PATH.'
}

function Resolve-Node {
    $candidates = @(
        'C:\Users\13329\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
    )
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

# ---- 1) front end ----
if (-not $SkipWebBuild) {
    if (-not (Test-Path (Join-Path $webDir 'package.json'))) {
        throw "web front end not found: $webDir"
    }
    $node = Resolve-Node
    if (-not $node) {
        throw 'node not found; build the front end manually (cd web; pnpm build) or pass -SkipWebBuild.'
    }
    $pnpmMjs = 'C:\Users\13329\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
    # pnpm on Windows resolves the script shims (tsc.cmd / vite.cmd) through cmd.exe,
    # so node.exe must be on PATH as well, not just given as an absolute path.
    $nodeDir = Split-Path $node -Parent
    $env:PATH = "$nodeDir;$env:PATH"
    Write-Host "web build: $webDir"
    Push-Location $webDir
    try {
        if (Test-Path $pnpmMjs) {
            & $node $pnpmMjs run build
        } else {
            & $node (Join-Path (Split-Path $node) '..\node_modules\npm\bin\npm-cli.js') run build
        }
        if ($LASTEXITCODE -ne 0) { throw "web build failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path (Join-Path $webDist 'index.html'))) {
    throw "web/dist/index.html missing; run the web build first or omit -SkipWebBuild."
}

# ---- 2) dotnet publish ----
if (-not $env:DOTNET_CLI_HOME) {
    $cliHome = 'E:\aurora-toolchain\clihome'
    if (Test-Path $cliHome) { $env:DOTNET_CLI_HOME = $cliHome }
}
if (-not $env:NUGET_PACKAGES) {
    $nugetCache = 'E:\aurora-toolchain\nuget'
    if (Test-Path $nugetCache) { $env:NUGET_PACKAGES = $nugetCache }
}
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'

$dotnet = Resolve-Dotnet
$selfContainedValue = if ($SelfContained) { 'true' } else { 'false' }
# Framework-dependent single-file builds cannot bundle compressed assemblies (NETSDK1176),
# so compression is only added for the self-contained flavor.
$singleFileArgs = @(
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true'
)
if ($SelfContained) { $singleFileArgs += '-p:EnableCompressionInSingleFile=true' }
$publishArgs = @(
    'publish', $project,
    '-c', $Configuration,
    '-r', 'win-x64',
    '--self-contained', $selfContainedValue
) + $singleFileArgs + @(
    '-p:DebugType=None',
    '-p:DebugSymbols=false',
    '-o', $OutputDirectory,
    '--nologo', '-v:minimal'
)
if ($SkipRestore) { $publishArgs += '--no-restore' }
if ($Version) {
    $publishArgs += "-p:Version=$Version"
    Write-Host "publish version override: $Version"
}
if ($UpdateRepo) {
    $publishArgs += "-p:ZiluxUpdateRepo=$UpdateRepo"
    Write-Host "publish update repo override: $UpdateRepo"
}

Write-Host "publish: $project -> $OutputDirectory (self-contained=$selfContainedValue)"
& $dotnet @publishArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0 -and -not $SkipRestore -and $offlineSource) {
    Write-Host 'retrying with the offline package source...'
    & $dotnet @publishArgs --source $offlineSource --ignore-failed-sources
    $exitCode = $LASTEXITCODE
}
if ($exitCode -ne 0) { throw "dotnet publish failed with exit code $exitCode." }

# ---- 3) verify + launcher ----
$exe = Join-Path $OutputDirectory 'Zilux2.exe'
if (-not (Test-Path $exe)) { throw "published exe missing: $exe" }
if (-not (Test-Path (Join-Path $OutputDirectory 'web\index.html'))) {
    throw "published web payload missing: $OutputDirectory\web\index.html"
}

# Trim documentation XML that the WebView2 package dumps next to the exe (not needed at runtime).
Get-ChildItem $OutputDirectory -Filter 'Microsoft.Web.WebView2.*.xml' -File |
    Remove-Item -Force -ErrorAction SilentlyContinue

$launcher = Join-Path $OutputDirectory '启动 Zilux2.cmd'
$launcherBody = "@echo off`r`nstart `"`" `"%~dp0Zilux2.exe`"`r`n"
[IO.File]::WriteAllText($launcher, $launcherBody, (New-Object Text.UTF8Encoding $false))

$exeSize = (Get-Item $exe).Length
$webSize = (Get-ChildItem (Join-Path $OutputDirectory 'web') -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("publish ok: {0} ({1:N0} bytes) + web payload {2:N0} bytes" -f $exe, $exeSize, $webSize)
Write-Host "folder: $OutputDirectory"
