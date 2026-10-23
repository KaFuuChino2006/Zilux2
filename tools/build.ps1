#Requires -Version 5.1
<#
.SYNOPSIS
    Builds the Zilux2 WPF host.
.DESCRIPTION
    Idempotent: re-running picks up changed sources and stale output harmlessly.
    Offline/NuGet details are pinned to this machine's toolchain.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',

    # Optional built web front end (e.g. .\web\dist). Copied to <out>\web.
    [string]$WebDir,

    [switch]$SkipRestore
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'src\Zilux2\Zilux2.csproj'
$tfm = 'net10.0-windows10.0.19041.0'
$outDir = Join-Path $repoRoot "src\Zilux2\bin\$Configuration\$tfm"
$exe = Join-Path $outDir 'Zilux2.exe'
$offlineSource = 'E:\aurora-toolchain\nuget'

function Resolve-Dotnet {
    $candidates = @('E:\dotnet\dotnet.exe')
    $onPath = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    throw 'dotnet executable not found: expected E:\dotnet\dotnet.exe or dotnet on PATH.'
}

function Resolve-FullPath([string]$Path) {
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
}

# Keep the SDK's home and package cache out of the user profile: the machine has a
# prepared toolchain there and NuGet is expected to work offline.
if (-not $env:DOTNET_CLI_HOME) { $env:DOTNET_CLI_HOME = 'E:\aurora-toolchain\clihome' }
if (-not $env:NUGET_PACKAGES) { $env:NUGET_PACKAGES = 'E:\aurora-toolchain\nuget' }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'

$dotnet = Resolve-Dotnet
Write-Host "dotnet: $dotnet"
Write-Host "project: $project"
Write-Host "configuration: $Configuration"

$buildArgs = @('build', $project, '-c', $Configuration, '--nologo', '-v:minimal')
if ($SkipRestore) { $buildArgs += '--no-restore' }

& $dotnet @buildArgs
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0 -and -not $SkipRestore) {
    # First attempt can trip over unreachable feeds; retry against the local package cache only.
    Write-Host 'retrying with the offline package source...'
    $retryArgs = $buildArgs + @('--source', $offlineSource, '--ignore-failed-sources')
    & $dotnet @retryArgs
    $exitCode = $LASTEXITCODE
}

if ($exitCode -ne 0) {
    throw "dotnet build failed with exit code $exitCode."
}

# Explicit -WebDir wins; otherwise ship the repo's built front end if it exists.
if (-not $WebDir -and (Test-Path (Join-Path $repoRoot 'web\dist\index.html'))) {
    $WebDir = Join-Path $repoRoot 'web\dist'
}

if ($WebDir) {
    $source = Resolve-FullPath $WebDir
    if (-not (Test-Path (Join-Path $source 'index.html'))) {
        throw "-WebDir does not contain index.html: $source"
    }
    $target = Join-Path $outDir 'web'
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
    Write-Host "web copied: $source -> $target"
}

if (-not (Test-Path $exe)) {
    throw "build succeeded but the executable is missing: $exe"
}

$size = (Get-Item $exe).Length
Write-Host "build ok: $exe ($size bytes)"
