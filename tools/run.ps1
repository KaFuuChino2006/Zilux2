#Requires -Version 5.1
<#
.SYNOPSIS
    Builds and starts the Zilux2 host.
.DESCRIPTION
    Idempotent: always passes through build.ps1 first (unless -SkipBuild), then starts
    the exe with the requested content source in the environment.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',

    # Dev server origin, e.g. http://localhost:5173
    [string]$DevUrl,

    # Folder holding index.html (e.g. .\src\Zilux2\_devtest). Also copied into the build output.
    [string]$WebDir,

    [switch]$Dev,
    [switch]$SkipBuild,
    [switch]$Wait
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$tfm = 'net10.0-windows10.0.19041.0'
$outDir = Join-Path $repoRoot "src\Zilux2\bin\$Configuration\$tfm"
$exe = Join-Path $outDir 'Zilux2.exe'
$logPath = Join-Path $env:LOCALAPPDATA 'Zilux2\logs\host.log'

if (-not $SkipBuild) {
    $buildArgs = @{ Configuration = $Configuration }
    if ($WebDir) { $buildArgs.WebDir = $WebDir }
    & (Join-Path $PSScriptRoot 'build.ps1') @buildArgs
}

if (-not (Test-Path $exe)) {
    throw "executable not found: $exe (run tools\build.ps1 first)"
}

# Rebuild the child environment from scratch so a stale value in the parent shell
# can never silently pick the wrong content.
Remove-Item Env:ZILUX2_DEV_URL -ErrorAction SilentlyContinue
Remove-Item Env:ZILUX2_WEB_DIR -ErrorAction SilentlyContinue
Remove-Item Env:ZILUX2_DEV -ErrorAction SilentlyContinue

if ($DevUrl) {
    $env:ZILUX2_DEV_URL = $DevUrl
    Write-Host "ZILUX2_DEV_URL=$DevUrl"
}

if ($WebDir) {
    $resolved = if ([IO.Path]::IsPathRooted($WebDir)) { [IO.Path]::GetFullPath($WebDir) } else { [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $WebDir)) }
    if (-not (Test-Path (Join-Path $resolved 'index.html'))) {
        throw "-WebDir does not contain index.html: $resolved"
    }
    $env:ZILUX2_WEB_DIR = $resolved
    Write-Host "ZILUX2_WEB_DIR=$resolved"
}

if ($Dev) {
    $env:ZILUX2_DEV = '1'
    Write-Host 'ZILUX2_DEV=1 (DevTools enabled)'
}

Write-Host "log: $logPath"
$process = Start-Process -FilePath $exe -PassThru -WorkingDirectory $repoRoot
Write-Host "started: pid=$($process.Id)"

if ($Wait) {
    $process.WaitForExit()
    Write-Host "exited: code=$($process.ExitCode)"
}
