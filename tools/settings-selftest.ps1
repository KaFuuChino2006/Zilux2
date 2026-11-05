#Requires -Version 5.1
<#
    Host-side self-test for docs/zilux2-settings-contract.md.

    Covers contract §7 checks 1-11 plus regression checks:
      1. first launch without a settings file -> default snapshot, no error
      2. patch -> ACK snapshot with new values + valid JSON on disk
      3. restart -> request returns the persisted values
      4. invalid value types -> fall back to defaults, host stays alive
      5. reset -> file and snapshot are defaults again, unknown keys preserved
      6. corrupt JSON -> defaults, .corrupt-* backup, `load failed` log
      7. settings messages do not break ready / windowState / online service
      8. shortcuts re-register / disabled / invalid keeps last / reset
      9. autoLaunch Run value (isolated test key) + autoStartHidden command
     10. watchLocalFolder disables/restarts the watcher logs
     11. alwaysHandleMediaKeys flips without restart (snapshot/log proof)
     12. loading both lyrics flags true keeps only backgroundLyrics
     13. unreadable settings file is not overwritten by defaults

    Runs on Windows PowerShell 5.1 and PowerShell 7+. Every launch uses
    ZILUX2_SETTINGS_PATH under tools/_out and an isolated auto-launch Run key,
    so the real %LOCALAPPDATA%\Zilux2\settings.json and the user's real Run
    value are never touched.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

# 测试模式：主窗口收到 WM_CLOSE 直接退出，而不是隐藏到托盘（P2-02）。
$env:ZILUX2_SELFTEST = '1'

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
$script:TestRunKey = 'Software\Zilux2\SettingsSelfTest\Run'

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

function Get-ShortcutState([string]$Text) {
    if (-not $Text) { return $null }
    $state = $null
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match 'settingsprobe hostmsg (\{.*\})\s*$') {
            try { $message = $Matches[1] | ConvertFrom-Json } catch { continue }
            if ($message.type -eq 'host' -and $message.event -eq 'shortcuts') {
                $state = $message.state
            }
        }
    }
    return $state
}

function Get-AllSnapshotStates([string]$Text) {
    $states = @()
    if (-not $Text) { return $states }
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match 'settingsprobe snapshot #\d+ (\{.*\})\s*$') {
            try { $states += ($Matches[1] | ConvertFrom-Json) } catch { }
        }
    }
    return $states
}

function Get-ShortcutItem($State, [string]$Action) {
    if ($null -eq $State -or $null -eq $State.items) { return $null }
    return @($State.items | Where-Object { $_.action -eq $Action })[0]
}

function New-ScenarioPage([string]$Scenario, [string]$ExtraScript = '') {
    $template = [System.IO.File]::ReadAllText($script:ProbeTemplatePath)
    $page = $template.Replace('__SCENARIO__', '"' + $Scenario + '"')
    if ($ExtraScript) {
        # Inject inside the probe's existing <script> so the helper can reuse `bridge`/`log`.
        $close = $page.LastIndexOf('</script>')
        if ($close -ge 0) {
            $page = $page.Insert($close, "`r`n    " + $ExtraScript + "`r`n")
        }
    }
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
    $env:ZILUX2_AUTOLAUNCH_RUN_KEY = $script:TestRunKey
    # The cleanup above removes every ZILUX2_* variable, including the test-mode flag.
    $env:ZILUX2_SELFTEST = '1'

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
        ($Json.general.autoLaunch -eq $false) -and
        ($Json.general.autoStartHidden -eq $true) -and
        ($Json.general.watchLocalFolder -eq $true) -and
        ($Json.general.mediaSession -eq $true) -and
        ($Json.general.desktopLyrics -eq $false) -and
        ($Json.general.backgroundLyrics -eq $false) -and
        ($Json.appearance.theme -eq 'dark') -and
        ($Json.appearance.reduceMotion -eq $false) -and
        ($Json.appearance.glow -eq $true) -and
        ($Json.appearance.lyricsSize -eq 'medium') -and
        ($Json.appearance.windowAnimation -eq 'custom') -and
        ($Json.appearance.miniSize -eq 'standard') -and
        ($Json.playback.defaultSource -eq 'netease') -and
        ($Json.playback.searchLimit -eq 20) -and
        ($Json.playback.audioReactive -eq $true) -and
        ($Json.playback.quality -eq 'high') -and
        ($Json.playback.eqEnabled -eq $false) -and
        ($Json.playback.fadeOutMs -eq 450) -and
        ($Json.playback.fadeInMs -eq 450) -and
        ($Json.playback.sleepFadeSeconds -eq 15) -and
        ($Json.playback.sleepAction -eq 'pause') -and
        ([double]$Json.playback.volume -eq 0.72) -and
        ($Json.updates.autoCheck -eq $true) -and
        ($Json.updates.mode -eq 'auto') -and
        ($Json.shortcuts.enabled -eq $true) -and
        ($Json.shortcuts.alwaysHandleMediaKeys -eq $true)
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

$s8Extra = @'
    if (scenario === 'shortcuts') {
      const sendShortcutPatch = (payload, delay) => setTimeout(() => {
        log('settingsprobe patch ' + JSON.stringify(payload));
        bridge.postMessage({ v: 1, type: 'settings', action: 'patch', patch: payload });
      }, delay);
      sendShortcutPatch({ shortcuts: { enabled: false } }, 400);
      sendShortcutPatch({ shortcuts: { enabled: true, playPause: 'Ctrl+Alt+Shift+F12' } }, 1400);
      sendShortcutPatch({ shortcuts: { playPause: 'Ctrl+Alt+NotAKey' } }, 2400);
      sendShortcutPatch({ shortcuts: { playPause: 'Ctrl+Alt+Shift+F11' } }, 3400);
      setTimeout(() => {
        log('settingsprobe reset sent');
        bridge.postMessage({ v: 1, type: 'settings', action: 'reset' });
      }, 4400);
    }
'@
$shortcutPage = New-ScenarioPage 'shortcuts' $s8Extra

$s9Extra = @'
    if (scenario === 'autolaunch') {
      const sendAutoLaunch = (value, delay) => setTimeout(() => {
        const patch = { general: { autoLaunch: value, autoStartHidden: true } };
        log('settingsprobe patch ' + JSON.stringify(patch));
        bridge.postMessage({ v: 1, type: 'settings', action: 'patch', patch: patch });
      }, delay);
      sendAutoLaunch(true, 500);
      sendAutoLaunch(false, 1900);
    }
'@
$autoLaunchPage = New-ScenarioPage 'autolaunch' $s9Extra

$s10Extra = @'
    if (scenario === 'watch') {
      const sendWatch = (value, delay) => setTimeout(() => {
        const patch = { general: { watchLocalFolder: value } };
        log('settingsprobe patch ' + JSON.stringify(patch));
        bridge.postMessage({ v: 1, type: 'settings', action: 'patch', patch: patch });
      }, delay);
      sendWatch(false, 500);
      sendWatch(true, 1700);
    }
'@
$watchPage = New-ScenarioPage 'watch' $s10Extra

$s11Extra = @'
    if (scenario === 'mediakeys') {
      const sendAlways = (value, delay) => setTimeout(() => {
        const patch = { shortcuts: { alwaysHandleMediaKeys: value } };
        log('settingsprobe patch ' + JSON.stringify(patch));
        bridge.postMessage({ v: 1, type: 'settings', action: 'patch', patch: patch });
      }, delay);
      sendAlways(false, 500);
      sendAlways(true, 1700);
    }
'@
$mediaKeysPage = New-ScenarioPage 'mediakeys' $s11Extra

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
$s5Json = @'
{
  "version": 1,
  "general": { "customKeep": "general-unknown" },
  "appearance": { "futureLook": "appearance-unknown" },
  "futureTop": { "keep": 42 }
}
'@
[System.IO.File]::WriteAllText($s5Settings, $s5Json, $script:Utf8NoBom)
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
    Assert 'S5 reset preserves unknown general key' ($s5File.Json.general.customKeep -eq 'general-unknown')
    Assert 'S5 reset preserves unknown appearance key' ($s5File.Json.appearance.futureLook -eq 'appearance-unknown')
    Assert 'S5 reset preserves unknown top-level key' ($s5File.Json.futureTop.keep -eq 42)
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
  "appearance": { "theme": "dark", "reduceMotion": false, "glow": true, "lyricsSize": "medium", "windowAnimation": "custom" },
  "playback": { "defaultSource": "netease", "searchLimit": 20, "audioReactive": true, "volume": 0.72 }
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

# ------------------------------------------------- S8: shortcuts lifecycle
Write-Host '--- S8 shortcuts: re-register / disabled / invalid keeps last / reset'
$s8Settings = Get-ProfilePath 's8'
$s8 = Start-SettingsHost $shortcutPage $s8Settings
$s8Disabled = Wait-LogMatch $s8.Offset 'hotkey\.apply enabled=false count=0 reason=settings' 40 'S8 shortcuts disabled'
if ($s8Disabled) {
    Start-Sleep -Milliseconds 250
    $s8State = Get-ShortcutState (Read-LogFrom $s8.Offset)
    $s8Item = Get-ShortcutItem $s8State 'playPause'
    Assert 'S8 disabled state event' ($null -ne $s8State -and $s8State.enabled -eq $false)
    Assert 'S8 disabled item is not active' ($null -ne $s8Item -and $s8Item.ok -eq $false -and $s8Item.error -eq 'disabled')
}

$s8CustomKey = 'Ctrl+Alt+Shift+F12'
$s8Custom = Wait-LogMatch $s8.Offset ([regex]::Escape("hotkey.register id=1 ok action=playPause key=$s8CustomKey")) 30 'S8 custom re-register'
if ($s8Custom) {
    Start-Sleep -Milliseconds 250
    $s8State = Get-ShortcutState (Read-LogFrom $s8.Offset)
    $s8Item = Get-ShortcutItem $s8State 'playPause'
    Assert 'S8 custom shortcut applied' ($null -ne $s8Item -and $s8Item.configured -eq $s8CustomKey -and $s8Item.applied -eq $s8CustomKey -and $s8Item.ok -eq $true -and $s8Item.fallback -eq $false)
}

$s8Invalid = Wait-LogMatch $s8.Offset ([regex]::Escape('hotkey.configured action=playPause value=Ctrl+Alt+NotAKey invalid: keep previous registration')) 30 'S8 invalid keeps previous'
if ($s8Invalid) {
    Start-Sleep -Milliseconds 250
    $s8State = Get-ShortcutState (Read-LogFrom $s8.Offset)
    $s8Item = Get-ShortcutItem $s8State 'playPause'
    Assert 'S8 invalid shortcut fallback=true' ($null -ne $s8Item -and $s8Item.configured -eq 'Ctrl+Alt+NotAKey' -and $s8Item.applied -eq $s8CustomKey -and $s8Item.ok -eq $true -and $s8Item.fallback -eq $true)
}

$s8NextKey = 'Ctrl+Alt+Shift+F11'
$s8Next = Wait-LogMatch $s8.Offset ([regex]::Escape("hotkey.register id=1 ok action=playPause key=$s8NextKey")) 30 'S8 next re-register'
if ($s8Next) {
    Start-Sleep -Milliseconds 250
    $s8State = Get-ShortcutState (Read-LogFrom $s8.Offset)
    $s8Item = Get-ShortcutItem $s8State 'playPause'
    Assert 'S8 new shortcut applied' ($null -ne $s8Item -and $s8Item.configured -eq $s8NextKey -and $s8Item.applied -eq $s8NextKey -and $s8Item.ok -eq $true)
}

$s8Reset = Wait-LogMatch $s8.Offset '\[settings\] reset' 30 'S8 reset'
if ($s8Reset) {
    Start-Sleep -Milliseconds 500
    $s8State = Get-ShortcutState (Read-LogFrom $s8.Offset)
    $s8Item = Get-ShortcutItem $s8State 'playPause'
    Assert 'S8 reset restores default shortcut' ($null -ne $s8Item -and $s8Item.configured -eq 'Ctrl+Alt+Space' -and $s8Item.ok -eq $true -and $s8Item.applied.Length -gt 0)
}
$s8Exit = Close-SettingsHost $s8 'S8'
Assert 'S8 exit code 0' ($s8Exit -eq 0)

# ------------------------------------------------------- S9: autoLaunch Run
Write-Host '--- S9 autoLaunch: isolated Run value and --hidden command'
$s9Settings = Get-ProfilePath 's9'
$s9 = Start-SettingsHost $autoLaunchPage $s9Settings
$s9Registered = Wait-LogMatch $s9.Offset '\[autolaunch\] registered command=' 40 'S9 autolaunch registered'
if ($s9Registered) {
    $s9.Offset = Get-LogLength
    $s9Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:TestRunKey)
    $s9Value = $null
    if ($null -ne $s9Key) {
        $s9Value = $s9Key.GetValue('Zilux2')
        $s9Key.Dispose()
    }
    $s9Expected = '"' + $script:ExePath + '" --hidden'
    Assert 'S9 Run command has quoted exe + --hidden' ($s9Value -eq $s9Expected) ("value=$s9Value")

    $s9Unregistered = Wait-LogMatch $s9.Offset '\[autolaunch\] unregistered' 20 'S9 autolaunch unregistered'
    Assert 'S9 disable removes Run value' ($null -ne $s9Unregistered)
    $s9Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:TestRunKey)
    $s9Value = $null
    if ($null -ne $s9Key) {
        $s9Value = $s9Key.GetValue('Zilux2')
        $s9Key.Dispose()
    }
    Assert 'S9 Run value is gone' ($null -eq $s9Value)
}
$s9Exit = Close-SettingsHost $s9 'S9'
Assert 'S9 exit code 0' ($s9Exit -eq 0)

# ------------------------------------------------------- S10: watch switch
Write-Host '--- S10 watchLocalFolder: stop and restart logs'
$s10Settings = Get-ProfilePath 's10'
$s10 = Start-SettingsHost $watchPage $s10Settings
$s10Disabled = Wait-LogMatch $s10.Offset '\[local\] watch disabled by settings' 40 'S10 watch disabled'
Assert 'S10 watch disabled log' ($null -ne $s10Disabled)
if ($s10Disabled) {
    $s10.Offset = Get-LogLength
    $s10Enabled = Wait-LogMatch $s10.Offset '\[local\] watch enabled by settings' 20 'S10 watch enabled'
    Assert 'S10 watch enabled log' ($null -ne $s10Enabled)
}
$s10Exit = Close-SettingsHost $s10 'S10'
Assert 'S10 exit code 0' ($s10Exit -eq 0)

# ------------------------------------------------ S11: alwaysHandleMediaKeys
Write-Host '--- S11 alwaysHandleMediaKeys: flips without restart'
$s11Settings = Get-ProfilePath 's11'
$s11 = Start-SettingsHost $mediaKeysPage $s11Settings
$s11Off = Wait-LogMatch $s11.Offset 'settingsprobe patch .*alwaysHandleMediaKeys":false' 40 'S11 off patch'
if ($s11Off) {
    Start-Sleep -Milliseconds 400
    $s11States = @(Get-AllSnapshotStates (Read-LogFrom $s11.Offset))
    $s11SnapOff = @($s11States | Where-Object { $null -ne $_.shortcuts -and $_.shortcuts.alwaysHandleMediaKeys -eq $false })[0]
    Assert 'S11 snapshot reports alwaysHandleMediaKeys=false' ($null -ne $s11SnapOff)

    $s11On = Wait-LogMatch $s11.Offset 'settingsprobe patch .*alwaysHandleMediaKeys":true' 20 'S11 on patch'
    if ($s11On) {
        Start-Sleep -Milliseconds 400
        $s11States = @(Get-AllSnapshotStates (Read-LogFrom $s11.Offset))
        $s11SnapOn = @($s11States | Where-Object { $null -ne $_.shortcuts -and $_.shortcuts.alwaysHandleMediaKeys -eq $true })[0]
        Assert 'S11 snapshot reports alwaysHandleMediaKeys=true' ($null -ne $s11SnapOn)
    }
}
$s11Exit = Close-SettingsHost $s11 'S11'
Assert 'S11 exit code 0' ($s11Exit -eq 0)

# ------------------------------------------- S12: lyrics flags mutual exclusion
Write-Host '--- S12 load: both lyrics flags true keeps background only'
$s12Settings = Get-ProfilePath 's12'
$s12Json = @'
{
  "version": 1,
  "general": { "splash": true, "desktopLyrics": true, "backgroundLyrics": true }
}
'@
[System.IO.File]::WriteAllText($s12Settings, $s12Json, $script:Utf8NoBom)
$s12 = Start-SettingsHost $baselinePage $s12Settings
$s12Text = Wait-LogMatch $s12.Offset '\[settings\] load: desktopLyrics disabled because backgroundLyrics was enabled' 40 'S12 load mutual exclusion'
if ($s12Text) {
    $s12Snap = Get-SnapshotState $s12Text 1
    Assert 'S12 load disables desktopLyrics' ($null -ne $s12Snap -and $s12Snap.general.desktopLyrics -eq $false)
    Assert 'S12 load keeps backgroundLyrics' ($null -ne $s12Snap -and $s12Snap.general.backgroundLyrics -eq $true)
}
$s12Exit = Close-SettingsHost $s12 'S12'
Assert 'S12 exit code 0' ($s12Exit -eq 0)

# --------------------------------- S13: unreadable file must not be overwritten
Write-Host '--- S13 unreadable settings: defaults used, original file preserved'
$s13Settings = Get-ProfilePath 's13'
$s13Json = @'
{
  "version": 1,
  "general": { "splash": true },
  "appearance": { "theme": "dark" },
  "playback": { "volume": 0.42 }
}
'@
[System.IO.File]::WriteAllText($s13Settings, $s13Json, $script:Utf8NoBom)
$s13Original = [System.IO.File]::ReadAllText($s13Settings)
$s13Lock = [System.IO.File]::Open($s13Settings, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
    $s13 = Start-SettingsHost $patchPage $s13Settings
    $s13Text = Wait-LogMatch $s13.Offset '\[settings\] save skipped: settings file was unreadable' 45 'S13 save skipped'
    Assert 'S13 unreadable load does not overwrite' ($null -ne $s13Text)
    $s13Exit = Close-SettingsHost $s13 'S13'
    Assert 'S13 exit code 0' ($s13Exit -eq 0)
} finally {
    $s13Lock.Dispose()
}
$s13Final = [System.IO.File]::ReadAllText($s13Settings)
Assert 'S13 original bytes unchanged' ($s13Final -eq $s13Original)
$s13File = Read-SettingsFile $s13Settings
Assert 'S13 original volume still 0.42' ([double]$s13File.Json.playback.volume -eq 0.42)

# -------------------------------------------------------------- final checks
try {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($script:TestRunKey, $false)
} catch {
    # test key may not exist; nothing to clean.
}
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
