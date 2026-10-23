#Requires -Version 7.0
<#
    Host-side self-test for docs/zilux2-settings-contract.md.

    Covers contract §7 checks 1-7:
      1. first launch without a settings file -> default snapshot, no error
      2. patch -> ACK snapshot with new values + valid JSON on disk
      3. restart -> request returns the persisted values
      4. invalid value types -> fall back to defaults, host stays alive
      5. reset -> file and snapshot are defaults again
      6. corrupt JSON -> defaults, .corrupt-* backup, `load failed` log
      7. settings messages do not break ready / windowState / online service

    Every launch uses ZILUX2_SETTINGS_PATH under tools/_out so the real
    %LOCALAPPDATA%\Zilux2\settings.json is never touched.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$script:ExePath = Join-Path $RepoRoot "src\Zilux2\bin\$Configuration\net10.0-windows10.0.19041.0\Zilux2.exe"
$script:LogPath = Join-Path $env:LOCALAPPDATA 'Zilux2\logs\host.log'
$script:WorkDir = Join-Path $RepoRoot 'tools\_out\settings-selftest'
$script:PagesDir = Join-Path $script:WorkDir 'pages'
$script:ProfilesDir = Join-Path $script:WorkDir 'profiles'
$script:ProbeTemplatePath = Join-Path $RepoRoot 'src\Zilux2\_devtest\settings-probe.html'
$script:CurlExe = Join-Path $env:SystemRoot 'System32\curl.exe'
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:FixedToken = '0123456789abcdef0123456789abcdef'
$script:WmClose = 0x0010

$script:Passed = 0
$script:Failed = 0
$script:Failures = [System.Collections.Generic.List[string]]::new()

if (-not ('ZiluxSettingsTest.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ZiluxSettingsTest
{
    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    }
}
'@
}

function Pass([string]$Name, [string]$Detail = '') {
    $script:Passed++
    $line = "  PASS  $Name"
    if ($Detail) { $line += "  [$Detail]" }
    Write-Host $line
}

function Fail([string]$Name, [string]$Detail = '') {
    $script:Failed++
    $script:Failures.Add("$Name  $Detail")
    $line = "  FAIL  $Name"
    if ($Detail) { $line += "  [$Detail]" }
    Write-Host $line
}

function Assert([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) { Pass $Name $Detail } else { Fail $Name $Detail }
}

function Get-LogLength {
    if (-not (Test-Path -LiteralPath $script:LogPath)) { return [long]0 }
    try { return [long](Get-Item -LiteralPath $script:LogPath).Length } catch { return [long]0 }
}

function Read-LogFrom([long]$Offset) {
    if (-not (Test-Path -LiteralPath $script:LogPath)) { return '' }
    try {
        $stream = [System.IO.File]::Open($script:LogPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    } catch {
        return ''
    }

    try {
        if ($Offset -ge $stream.Length) { return '' }
        $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally {
        $stream.Dispose()
    }
}

function Wait-LogMatch([long]$Offset, [string]$Pattern, [int]$TimeoutSeconds, [string]$Label) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $text = Read-LogFrom $Offset
        if ($text -match $Pattern) { return $text }
        Start-Sleep -Milliseconds 120
    }

    $tail = (Read-LogFrom $Offset).TrimEnd() -split "`r?`n"
    Fail "timeout: $Label" ("pattern={0}; tail={1}" -f $Pattern, (($tail | Select-Object -Last 5) -join ' || '))
    return $null
}

function Get-SnapshotJson([string]$Text, [int]$Index) {
    if (-not $Text) { return $null }
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match ('settingsprobe snapshot #' + $Index + ' (\{.*\})\s*$')) {
            return $Matches[1]
        }
    }
    return $null
}

function Get-SnapshotState([string]$Text, [int]$Index) {
    $json = Get-SnapshotJson $Text $Index
    if (-not $json) { return $null }
    try { return ($json | ConvertFrom-Json) } catch { return $null }
}

function New-ScenarioPage([string]$Scenario) {
    $template = [System.IO.File]::ReadAllText($script:ProbeTemplatePath)
    $page = $template.Replace('__SCENARIO__', '"' + $Scenario + '"')
    $dir = Join-Path $script:PagesDir $Scenario
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $dir 'index.html'), $page, $script:Utf8NoBom)
    return $dir
}

function Get-ProfilePath([string]$Name) {
    $dir = Join-Path $script:ProfilesDir $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return (Join-Path $dir 'settings.json')
}

function Start-SettingsHost([string]$PageDir, [string]$SettingsPath) {
    Get-Process -Name Zilux2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-ChildItem Env: -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'ZILUX2_*' } |
        ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue }

    $env:ZILUX2_WEB_DIR = $PageDir
    $env:ZILUX2_SETTINGS_PATH = $SettingsPath
    $env:ZILUX2_ONLINE_TOKEN = $script:FixedToken

    $offset = Get-LogLength
    $proc = Start-Process -FilePath $script:ExePath -PassThru
    $session = [pscustomobject]@{ Process = $proc; Offset = $offset }

    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { break }
        $proc.Refresh()
        if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { return $session }
        Start-Sleep -Milliseconds 120
    }

    if ($proc.HasExited) {
        Fail 'host window appeared' ("exited early code={0}" -f $proc.ExitCode)
    } else {
        Fail 'host window appeared' 'timeout after 25s'
    }
    return $session
}

function Close-SettingsHost($Session, [string]$Label) {
    $proc = $Session.Process
    if (-not $proc.HasExited) {
        $proc.Refresh()
        $hwnd = $proc.MainWindowHandle
        if ($hwnd -ne [IntPtr]::Zero) {
            [ZiluxSettingsTest.Native]::PostMessage($hwnd, $script:WmClose, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        }
        if (-not $proc.WaitForExit(10000)) {
            $proc.Kill()
            Fail "$Label exited" 'timeout, process killed'
            return $null
        }
    }

    Pass "$Label exited" ("code={0}" -f $proc.ExitCode)
    return $proc.ExitCode
}

function Get-HealthStatus([int]$Port) {
    try {
        $status = & $script:CurlExe -s -S -m 10 -o NUL -w '%{http_code}' "http://127.0.0.1:$Port/api/health" 2>$null
        return [string]$status
    } catch {
        return 'curl-error'
    }
}

function Get-HealthBody([int]$Port) {
    try {
        return [string](& $script:CurlExe -s -S -m 10 "http://127.0.0.1:$Port/api/health" 2>$null)
    } catch {
        return ''
    }
}

function Read-SettingsFile([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $text = $script:Utf8NoBom.GetString($bytes)
    return [pscustomobject]@{ HasBom = $hasBom; Text = $text; Json = ($text | ConvertFrom-Json) }
}

function Assert-DefaultValues([string]$Name, $Json) {
    $ok = ($Json.version -eq 1) -and
        ($Json.general.splash -eq $true) -and
        ($Json.general.startMaximized -eq $false) -and
        ($Json.appearance.theme -eq 'dark') -and
        ($Json.appearance.reduceMotion -eq $false) -and
        ($Json.appearance.glow -eq $true) -and
        ($Json.appearance.heroAutoRotate -eq $true) -and
        ($Json.appearance.lyricsSize -eq 'medium') -and
        ($Json.playback.defaultSource -eq 'netease') -and
        ($Json.playback.searchLimit -eq 20) -and
        ($Json.playback.lyricsAutoOpen -eq $true) -and
        ([double]$Json.playback.volume -eq 0.72)
    Assert $Name $ok
}

$startedAt = Get-Date
Write-Host '=== Zilux2 settings self-test ==='
Write-Host "repo:      $RepoRoot"
Write-Host "exe:       $script:ExePath"
Write-Host "log:       $script:LogPath"
Write-Host "workdir:   $script:WorkDir"

if (-not $SkipBuild) {
    Write-Host '--- build'
    & (Join-Path $PSScriptRoot 'build.ps1') -Configuration $Configuration
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'BUILD FAILED'
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $script:ExePath)) {
    Write-Host "missing exe: $script:ExePath"
    exit 1
}

if (Test-Path -LiteralPath $script:WorkDir) { Remove-Item -LiteralPath $script:WorkDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $script:PagesDir | Out-Null
New-Item -ItemType Directory -Force -Path $script:ProfilesDir | Out-Null

$baselinePage = New-ScenarioPage 'baseline'
$patchPage = New-ScenarioPage 'patch'
$invalidPage = New-ScenarioPage 'invalid'
$resetPage = New-ScenarioPage 'reset'
$startMaxPage = New-ScenarioPage 'startmax'

# ---------------------------------------------------------------- S1: defaults
Write-Host '--- S1 first launch: default snapshot before ready, online/window flow intact'
$s1Settings = Get-ProfilePath 's1'
$s1 = Start-SettingsHost $baselinePage $s1Settings
$s1Text = Wait-LogMatch $s1.Offset 'page\.ready' 40 'S1 page.ready'
if ($s1Text) {
    Assert 'S1 load defaults (file missing)' ($s1Text -match '\[settings\] load path=.* defaults \(file missing\)')
    Assert 'S1 settings request answered' ($s1Text -match '\[settings\] request')

    $snap1 = Get-SnapshotJson $s1Text 1
    Assert 'S1 snapshot #1 present' ($null -ne $snap1)
    Assert 'S1 snapshot #1 has defaults' ($snap1 -match '"volume":0\.72' -and $snap1 -match '"theme":"dark"' -and $snap1 -match '"version":1')

    $snapPos = $s1Text.IndexOf('settingsprobe snapshot #1')
    $readyPos = $s1Text.IndexOf('] page.ready')
    Assert 'S1 request ACK arrives before page.ready' ($snapPos -ge 0 -and $readyPos -gt $snapPos) ("snap=$snapPos ready=$readyPos")

    $s1After = Wait-LogMatch $s1.Offset 'settingsprobe snapshot #2' 15 'S1 ready snapshot push'
    Assert 'S1 snapshot pushed again after ready' ($null -ne $s1After)

    $windowState = Wait-LogMatch $s1.Offset '"event":"windowState","maximized":true' 15 'S1 windowState maximize'
    Assert 'S1 windowState still pushed' ($null -ne $windowState)
    $windowStateBack = Wait-LogMatch $s1.Offset '"event":"windowState","maximized":false' 15 'S1 windowState restore'
    Assert 'S1 windowState restore pushed' ($null -ne $windowStateBack)

    if ($s1Text -match '\[online\] listening on 127\.0\.0\.1:(\d+)') {
        $port = [int]$Matches[1]
        Assert 'S1 online health 200' ((Get-HealthStatus $port) -eq '200') "port=$port"
        $body = Get-HealthBody $port
        Assert 'S1 online health ok' ($body -match '"ok":true')
        Assert 'S1 online endpoint pushed' ($s1Text -match '\[online\] endpoint sent to page port=')
    } else {
        Fail 'S1 online listening line' 'not found'
    }

    $s1Exit = Close-SettingsHost $s1 'S1'
    Assert 'S1 exit code 0' ($s1Exit -eq 0)

    $s1Final = Read-LogFrom $s1.Offset
    Assert 'S1 no settings file created' (-not (Test-Path -LiteralPath $s1Settings))
    Assert 'S1 token absent from host.log' (-not ($s1Final -match [regex]::Escape($script:FixedToken)))
    Assert 'S1 no unhandled host errors' (-not ($s1Final -match 'unhandled\.'))
    Assert 'S1 no webview2 process_failed' (-not ($s1Final -match 'process_failed'))
}

# ---------------------------------------------------- S2: patch + persistence file
Write-Host '--- S2 patch: ACK snapshot + valid JSON file'
$s2Settings = Get-ProfilePath 's2'
$s2 = Start-SettingsHost $patchPage $s2Settings
$s2Text = Wait-LogMatch $s2.Offset '\[settings\] save ok' 40 'S2 save ok'
if ($s2Text) {
    # Snapshot order: #1 request ACK, #2 ready-time push, #3 patch ACK (patch fires at 400 ms).
    $s2Ack = Wait-LogMatch $s2.Offset 'settingsprobe snapshot #3' 15 'S2 patch ACK snapshot'
    $s2Text = Read-LogFrom $s2.Offset
    $snap2 = Get-SnapshotState $s2Text 3
    Assert 'S2 patch ACK snapshot present' ($null -ne $snap2)
    Assert 'S2 patch ACK has new values' ($null -ne $snap2 -and [double]$snap2.playback.volume -eq 0.5 -and $snap2.appearance.reduceMotion -eq $true -and $snap2.appearance.theme -eq 'midnight')
    Assert 'S2 patch keys logged' ($s2Text -match '\[settings\] patch keys=')
}

$s2Exit = Close-SettingsHost $s2 'S2'
Assert 'S2 exit code 0' ($s2Exit -eq 0)
if (Test-Path -LiteralPath $s2Settings) {
    Pass 'S2 settings file exists'
    $s2File = Read-SettingsFile $s2Settings
    Assert 'S2 file has no BOM' (-not $s2File.HasBom)
    Assert 'S2 file parses as JSON' ($s2File.Json -ne $null)
    Assert 'S2 file version 1' ($s2File.Json.version -eq 1)
    Assert 'S2 file keeps patched volume' ([double]$s2File.Json.playback.volume -eq 0.5)
    Assert 'S2 file keeps patched reduceMotion' ($s2File.Json.appearance.reduceMotion -eq $true)
    Assert 'S2 file keeps patched theme' ($s2File.Json.appearance.theme -eq 'midnight')
    Assert 'S2 file keeps unpatched default' ([double]$s2File.Json.playback.searchLimit -eq 20)
} else {
    Fail 'S2 settings file exists' 'missing after exit'
}

# ------------------------------------------------------ S3: restart persistence
Write-Host '--- S3 restart: request returns persisted values'
if (Test-Path -LiteralPath $s2Settings) {
    $s3 = Start-SettingsHost $baselinePage $s2Settings
    $s3Text = Wait-LogMatch $s3.Offset 'settingsprobe snapshot #1' 40 'S3 persisted snapshot'
    if ($s3Text) {
        $snap3 = Get-SnapshotState $s3Text 1
        Assert 'S3 request ACK present' ($null -ne $snap3)
        Assert 'S3 volume persisted' ($null -ne $snap3 -and [double]$snap3.playback.volume -eq 0.5)
        Assert 'S3 reduceMotion persisted' ($null -ne $snap3 -and $snap3.appearance.reduceMotion -eq $true)
        Assert 'S3 theme persisted' ($null -ne $snap3 -and $snap3.appearance.theme -eq 'midnight')
    }
    $s3Exit = Close-SettingsHost $s3 'S3'
    Assert 'S3 exit code 0' ($s3Exit -eq 0)
} else {
    Fail 'S3 restart' 'S2 profile missing, skipped'
}

# ------------------------------------------------------ S4: invalid value types
Write-Host '--- S4 invalid patch: fall back to defaults without crashing'
$s4Settings = Get-ProfilePath 's4'
$s4 = Start-SettingsHost $invalidPage $s4Settings
$s4Text = Wait-LogMatch $s4.Offset 'settingsprobe snapshot #3' 40 'S4 invalid ACK snapshot'
if ($s4Text) {
    $s4Text = Read-LogFrom $s4.Offset
    $snap4 = Get-SnapshotState $s4Text 3
    Assert 'S4 invalid ACK present' ($null -ne $snap4)
    Assert 'S4 volume fell back to 0.72' ($null -ne $snap4 -and [double]$snap4.playback.volume -eq 0.72)
    Assert 'S4 searchLimit fell back to 20' ($null -ne $snap4 -and $snap4.playback.searchLimit -eq 20)
    Assert 'S4 theme fell back to dark' ($null -ne $snap4 -and $snap4.appearance.theme -eq 'dark')
    Assert 'S4 lyricsSize fell back to medium' ($null -ne $snap4 -and $snap4.appearance.lyricsSize -eq 'medium')
}
$s4Wait = Wait-LogMatch $s4.Offset '\[settings\] invalid key=' 20 'S4 invalid key log'
Assert 'S4 invalid values logged' ($null -ne $s4Wait)
$s4Exit = Close-SettingsHost $s4 'S4'
Assert 'S4 exit code 0 (no crash)' ($s4Exit -eq 0)
if (Test-Path -LiteralPath $s4Settings) {
    $s4File = Read-SettingsFile $s4Settings
    Assert-DefaultValues 'S4 file on disk has defaults' $s4File.Json
} else {
    Fail 'S4 settings file exists' 'missing after exit'
}

# ---------------------------------------------------------------- S5: reset
Write-Host '--- S5 reset: snapshot and file back to defaults'
$s5Settings = Get-ProfilePath 's5'
$s5 = Start-SettingsHost $resetPage $s5Settings
$s5Text = Wait-LogMatch $s5.Offset '\[settings\] reset' 40 'S5 reset log'
if ($s5Text) {
    # #1 request ACK, #2 ready push, #3 patch ACK, #4 reset ACK.
    $snap5Text = Wait-LogMatch $s5.Offset 'settingsprobe snapshot #4' 20 'S5 reset ACK'
    $snap5 = Get-SnapshotState $snap5Text 4
    Assert 'S5 reset ACK present' ($null -ne $snap5)
    Assert 'S5 reset ACK has defaults' ($null -ne $snap5 -and [double]$snap5.playback.volume -eq 0.72 -and $snap5.appearance.glow -eq $true -and $snap5.playback.searchLimit -eq 20)
}
Start-Sleep -Milliseconds 500
$s5Exit = Close-SettingsHost $s5 'S5'
Assert 'S5 exit code 0' ($s5Exit -eq 0)
if (Test-Path -LiteralPath $s5Settings) {
    $s5File = Read-SettingsFile $s5Settings
    Assert-DefaultValues 'S5 file reset to defaults' $s5File.Json
} else {
    Fail 'S5 settings file exists' 'missing after exit'
}

# --------------------------------------------------------- S6: corrupt settings
Write-Host '--- S6 corrupt JSON: defaults, .corrupt-* backup, load failed log'
$s6Settings = Get-ProfilePath 's6'
[System.IO.File]::WriteAllText($s6Settings, '{ "version": 1, "general": { "splash": true ', $script:Utf8NoBom)
$s6 = Start-SettingsHost $baselinePage $s6Settings
$s6Text = Wait-LogMatch $s6.Offset 'page\.ready' 40 'S6 page.ready'
if ($s6Text) {
    Assert 'S6 load failed logged' ($s6Text -match '\[settings\] load failed')
    $snap6 = Get-SnapshotJson $s6Text 1
    Assert 'S6 snapshot defaults' ($snap6 -match '"volume":0\.72' -and $snap6 -match '"theme":"dark"')
}
$s6Exit = Close-SettingsHost $s6 'S6'
Assert 'S6 exit code 0' ($s6Exit -eq 0)
$s6Backups = @(Get-ChildItem -LiteralPath (Split-Path -Parent $s6Settings) -Filter 'settings.json.corrupt-*' -ErrorAction SilentlyContinue)
Assert 'S6 corrupt backup created' ($s6Backups.Count -ge 1) ("count={0}" -f $s6Backups.Count)

# ------------------------------------------------------- S7: startMaximized
Write-Host '--- S7 startMaximized: window starts maximized and reports state'
$s7Settings = Get-ProfilePath 's7'
$s7Json = @'
{
  "version": 1,
  "general": { "splash": true, "startMaximized": true },
  "appearance": { "theme": "dark", "reduceMotion": false, "glow": true, "heroAutoRotate": true, "lyricsSize": "medium" },
  "playback": { "defaultSource": "netease", "searchLimit": 20, "lyricsAutoOpen": true, "volume": 0.72 }
}
'@
[System.IO.File]::WriteAllText($s7Settings, $s7Json, $script:Utf8NoBom)
$s7 = Start-SettingsHost $startMaxPage $s7Settings
$s7Text = Wait-LogMatch $s7.Offset 'page\.ready' 40 'S7 page.ready'
if ($s7Text) {
    Assert 'S7 startMaximized applied log' ($s7Text -match '\[settings\] startMaximized applied')
    # The window is maximized before Show, so window.state is logged before page.ready.
    Assert 'S7 window.state maximized=True' ($s7Text -match 'window\.state maximized=True')
    $snap7 = Get-SnapshotJson $s7Text 1
    Assert 'S7 snapshot startMaximized=true' ($snap7 -match '"startMaximized":true')
    $readyMsg = Wait-LogMatch $s7.Offset '"event":"ready","maximized":true' 15 'S7 ready message maximized'
    Assert 'S7 ready message reports maximized' ($null -ne $readyMsg)

    $s7.Process.Refresh()
    $s7Hwnd = $s7.Process.MainWindowHandle
    $s7Zoomed = $false
    if ($s7Hwnd -ne [IntPtr]::Zero) { $s7Zoomed = [ZiluxSettingsTest.Native]::IsZoomed($s7Hwnd) }
    Assert 'S7 window is maximized (IsZoomed)' $s7Zoomed
}
$s7Exit = Close-SettingsHost $s7 'S7'
Assert 'S7 exit code 0' ($s7Exit -eq 0)

# -------------------------------------------------------------- final checks
Get-Process -Name Zilux2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$leftovers = @(Get-Process -Name Zilux2 -ErrorAction SilentlyContinue)
Assert 'no leftover Zilux2 process' ($leftovers.Count -eq 0)

# Do not leak test env vars into the caller shell (a later tools/selftest.ps1 run in the
# same PowerShell session would inherit the S7 startMaximized profile otherwise).
Get-ChildItem Env: -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'ZILUX2_*' } |
    ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue }

$elapsed = ((Get-Date) - $startedAt).TotalSeconds
Write-Host ''
Write-Host ("=== settings self-test: {0} passed, {1} failed ({2:N1}s) ===" -f $script:Passed, $script:Failed, $elapsed)
if ($script:Failed -gt 0) {
    Write-Host 'failures:'
    foreach ($failure in $script:Failures) { Write-Host "  - $failure" }
    exit 1
}

exit 0
