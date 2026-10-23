#Requires -Version 7.0
<#
.SYNOPSIS
    Offline self-test for the AirPlay / RAOP sender (protocol + RTP packetisation).

.DESCRIPTION
    Runs Zilux2.exe with ZILUX2_AIRPLAY_SELFTEST=1. The host then executes
    Zilux2.DevTest.AirPlay.AirPlayLoopbackTest before creating any window or WebView2 and exits
    with code 0 only when every deterministic assertion passed. No Apple device, network,
    display or audio endpoint is required: the test starts an in-process mock RAOP receiver that
    binds ephemeral localhost TCP/UDP ports and drives a real RaopConnection + AirPlayStreamer
    pipeline against it.

    Covered: OPTIONS / ANNOUNCE (SDP) / SETUP (transport, session, latency) / RECORD (npt, RTP-Info),
    volume SET_PARAMETER body, FLUSH, TEARDOWN, sync packet, timing round-trip, resend responses,
    RTP sequence continuity, RTP timestamp step of 352 and payload byte budget.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $repoRoot "src\Zilux2\bin\$Configuration\net10.0-windows10.0.19041.0"
$exe = Join-Path $outDir 'Zilux2.exe'
$logPath = Join-Path $env:LOCALAPPDATA 'Zilux2\logs\host.log'

$script:Passed = 0
$script:Failed = 0

function Pass([string]$Name) {
    $script:Passed++
    Write-Host "  PASS $Name" -ForegroundColor Green
}

function Fail([string]$Name, [string]$Detail) {
    $script:Failed++
    Write-Host "  FAIL $Name - $Detail" -ForegroundColor Red
}

function Assert([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) { Pass $Name } else { Fail $Name $Detail }
}

function Get-LogLength {
    if (-not (Test-Path -LiteralPath $logPath)) { return 0 }
    return (Get-Item -LiteralPath $logPath).Length
}

function Read-LogFrom([long]$Offset) {
    if (-not (Test-Path -LiteralPath $logPath)) { return '' }
    $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($Offset -gt $stream.Length) { $Offset = 0 }
        $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    finally { $stream.Dispose() }
}

Write-Host "== airplay-selftest ==" -ForegroundColor Cyan

if (-not $SkipBuild) {
    & (Join-Path $repoRoot 'tools\build.ps1') -Configuration $Configuration -SkipRestore
    if ($LASTEXITCODE -ne 0) {
        Write-Host "build failed" -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "missing exe: $exe" -ForegroundColor Red
    exit 1
}

# Never let a leftover host process write into the log slice we are about to inspect.
Get-Process -Name Zilux2 -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

Get-ChildItem Env: | Where-Object { $_.Name -like 'ZILUX2_*' } | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" -ErrorAction SilentlyContinue }
$env:ZILUX2_AIRPLAY_SELFTEST = '1'

$offset = Get-LogLength
$startedAt = [DateTime]::UtcNow
$process = Start-Process -FilePath $exe -PassThru -WorkingDirectory $repoRoot
$exited = $process.WaitForExit(120000)
if (-not $exited) {
    $process.Kill()
    Write-Host "host did not exit within 120 s" -ForegroundColor Red
    exit 1
}

$elapsed = ([DateTime]::UtcNow - $startedAt).TotalSeconds
$log = Read-LogFrom $offset

Assert 'host exit code is 0' ($process.ExitCode -eq 0) "exit=$($process.ExitCode)"
Assert 'host exits quickly (no window)' ($elapsed -lt 60) ("elapsed={0:N1}s" -f $elapsed)
Assert 'selftest summary logged' ($log -match '\[airplay-test\] summary passed=(\d+) failed=(\d+)')

$summaryPassed = 0
$summaryFailed = 0
if ($log -match '\[airplay-test\] summary passed=(\d+) failed=(\d+)') {
    $summaryPassed = [int]$Matches[1]
    $summaryFailed = [int]$Matches[2]
}

$passLines = ([regex]::Matches($log, '\[airplay-test\] PASS ')).Count
$failLines = ([regex]::Matches($log, '\[airplay-test\] FAIL ')).Count
Assert 'summary reports zero failures' ($summaryFailed -eq 0 -and $failLines -eq 0) "summary=$summaryFailed lines=$failLines"
Assert 'summary passed count matches PASS lines' ($summaryPassed -eq $passLines) "summary=$summaryPassed lines=$passLines"
Assert 'at least 32 assertions ran' ($summaryPassed -ge 32) "passed=$summaryPassed"

$expected = @(
    'SETUP transport timing_port',
    'SETUP session id',
    'SETUP audio latency',
    'timing probe sent',
    'RECORD answered 200',
    'RECORD range npt=0-',
    'RECORD RTP-Info',
    'audio frames accepted',
    'resend probe sent',
    'audio packet count',
    'audio sequence contiguous',
    'audio timestamp step 352',
    'audio payload bytes',
    'sync packet received',
    'timing round-trip',
    'resend responses',
    'volume body',
    'FLUSH answered 200',
    'FLUSH RTP-Info',
    'TEARDOWN received',
    'TEARDOWN closed session',
    'connection packet count',
    'no unknown payload types',
    'mock errors empty'
)
foreach ($name in $expected) {
    Assert "assertion: $name" ($log.Contains("[airplay-test] PASS $name"))
}

Assert 'no [ERROR] lines' (-not ($log -match '\[ERROR\]')) ''
Assert 'no Apple credentials or keys leaked to log' (-not ($log -match 'pair-setup|LTPK|shk=|Nonce='))

Get-Process -Name Zilux2 -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host ""
Write-Host ("airplay-selftest: {0} passed, {1} failed" -f $script:Passed, $script:Failed) -ForegroundColor Cyan
if ($script:Failed -gt 0) {
    Write-Host "log tail:" -ForegroundColor Yellow
    ($log -split "`n" | Select-Object -Last 40) | ForEach-Object { Write-Host "  $_" }
    exit 1
}

Write-Host "all airplay self-checks passed" -ForegroundColor Green
exit 0
