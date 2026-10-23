#Requires -Version 7.0
<#
.SYNOPSIS
    Offline self-test for the host-side QR login plumbing (task-31).

.DESCRIPTION
    Runs Zilux2.exe with ZILUX2_ACCOUNT_SELFTEST=1. The host then executes
    Zilux2.Online.Account.AccountSelfCheck before creating any window or WebView2 and exits with
    code 0 only when every deterministic assertion passed. No network, display, token or account
    is required.

    Covered: QQ hash33, QR show/poll URLs, ptuiCB parsing (incl. escapes), check_sig / login_jump /
    authorize redirect validation, authorize form fields, musicu login body & credential parsing,
    credential cookies; Netease desktop identity cookies, type=3 forms, 800/801/802/803/8821 status
    mapping, unikey/code parsing, Set-Cookie + body-cookie extraction; shared LoginHttpResponse
    Location/Set-Cookie plumbing and Set-Cookie/cookie-header parsers.
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
    if ($Condition) {
        Pass $Name
    }
    else {
        Fail $Name $Detail
    }
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

Write-Host "== account-selftest ==" -ForegroundColor Cyan

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
$env:ZILUX2_ACCOUNT_SELFTEST = '1'

$offset = Get-LogLength
$startedAt = [DateTime]::UtcNow
$process = Start-Process -FilePath $exe -PassThru -WorkingDirectory $repoRoot
$exited = $process.WaitForExit(90000)
if (-not $exited) {
    $process.Kill()
    Write-Host "host did not exit within 90 s" -ForegroundColor Red
    exit 1
}

$elapsed = ([DateTime]::UtcNow - $startedAt).TotalSeconds
$log = Read-LogFrom $offset

Assert 'host exit code is 0' ($process.ExitCode -eq 0) "exit=$($process.ExitCode)"
Assert 'host exits quickly (no window)' ($elapsed -lt 30) ("elapsed={0:N1}s" -f $elapsed)
Assert 'selftest summary logged' ($log -match '\[account-selftest\] passed=(\d+) failed=(\d+)')

$summaryPassed = 0
$summaryFailed = 0
if ($log -match '\[account-selftest\] passed=(\d+) failed=(\d+)') {
    $summaryPassed = [int]$Matches[1]
    $summaryFailed = [int]$Matches[2]
}

$passLines = ([regex]::Matches($log, '\[account-selftest\] PASS ')).Count
$failLines = ([regex]::Matches($log, '\[account-selftest\] FAIL ')).Count
Assert 'summary reports zero failures' ($summaryFailed -eq 0 -and $failLines -eq 0) "summary=$summaryFailed lines=$failLines"
Assert 'summary passed count matches PASS lines' ($summaryPassed -eq $passLines) "summary=$summaryPassed lines=$passLines"
Assert 'at least 21 assertions ran' ($summaryPassed -ge 21) "passed=$summaryPassed"

$expected = @(
    'qq hash33 abc initial 0',
    'qq hash33 abc initial 5381',
    'qq ptuiCB confirmed',
    'qq authorize redirect code',
    'qq credential parse ok',
    'qq credential cookies',
    'netease desktop user agent',
    'netease poll form type 3',
    'netease identity device cookies',
    'netease status mapping',
    'netease risk control mapping',
    'netease response cookie body',
    'login response exposes location',
    'set-cookie parser'
)
foreach ($name in $expected) {
    Assert "assertion: $name" ($passLines -gt 0 -and $log.Contains("[account-selftest] PASS $name"))
}

Assert 'no [ERROR] lines' (-not ($log -match '\[ERROR\]')) ''
Assert 'no cookie values or token leaked to log' (-not ($log -match 'MUSIC_U=|qm_keyst=|qqmusic_key=|token='))

Get-Process -Name Zilux2 -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Host ""
Write-Host ("account-selftest: {0} passed, {1} failed" -f $script:Passed, $script:Failed) -ForegroundColor Cyan
if ($script:Failed -gt 0) {
    Write-Host "log tail:" -ForegroundColor Yellow
    ($log -split "`n" | Select-Object -Last 40) | ForEach-Object { Write-Host "  $_" }
    exit 1
}

Write-Host "all account self-checks passed" -ForegroundColor Green
exit 0
