#Requires -Version 7.0
<#
.SYNOPSIS
    End-to-end self-test for the Zilux2 host window.
.DESCRIPTION
    Launches the real exe against the devtest page and proves the contract behaviour
    without a human looking at the screen:
      * window appears, page loads, navigation completed is logged
      * host <-> page message round trip (ready -> host ready)
      * page-driven minimize / toggleMaximize / close
      * drag via the page 'drag' message actually moves the window
      * borderless edge resizing changes the window size (left / right / bottom)
      * a double click (drag message + toggleMaximize race) leaves the window maximized
      * dragging far off screen keeps the title bar reachable
      * missing front-end content shows a dialog and exits non-zero
    Screenshots are not used; Win32 window rectangles and host.log are the evidence.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',

    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$tfm = 'net10.0-windows10.0.19041.0'
$outDir = Join-Path $repoRoot "src\Zilux2\bin\$Configuration\$tfm"
$exe = Join-Path $outDir 'Zilux2.exe'
$logPath = Join-Path $env:LOCALAPPDATA 'Zilux2\logs\host.log'
$devtestDir = Join-Path $repoRoot 'src\Zilux2\_devtest'
$workRoot = Join-Path $repoRoot 'tools\_out\selftest'

# ---------------------------------------------------------------- Win32 plumbing

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Win32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref RECT rect, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    public const uint WM_CLOSE = 0x0010;
    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const int SW_RESTORE = 9;
    public const uint MONITOR_DEFAULTTONEAREST = 2;
}
'@

# ---------------------------------------------------------------- test bookkeeping

$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Passes = 0
$script:Evidence = New-Object System.Collections.Generic.List[string]
$script:Child = $null

function Pass([string]$Name, [string]$Detail = '') {
    $script:Passes++
    if ($Detail) {
        Write-Host "[PASS] $Name :: $Detail"
        $script:Evidence.Add("$Name :: $Detail")
    }
    else {
        Write-Host "[PASS] $Name"
        $script:Evidence.Add($Name)
    }
}

function Fail([string]$Name, [string]$Detail = '') {
    $message = if ($Detail) { "$Name :: $Detail" } else { $Name }
    Write-Host "[FAIL] $message" -ForegroundColor Red
    $script:Failures.Add($message)
}

function Check([bool]$Condition, [string]$Name, [string]$Detail = '') {
    if ($Condition) { Pass $Name $Detail } else { Fail $Name $Detail }
}

function Write-LogTail([string]$From, [int]$Lines = 12) {
    $text = Read-LogFrom $From
    if (-not $text) { Write-Host '       (log has no new lines)'; return }
    Write-Host '------- host.log tail -------'
    foreach ($line in ($text -split "`r?`n" | Where-Object { $_ } | Select-Object -Last $Lines)) {
        Write-Host "  $line"
    }
    Write-Host '-----------------------------'
}

# ---------------------------------------------------------------- log helpers

function Get-LogLength {
    if (Test-Path $logPath) { return [long](Get-Item $logPath).Length }
    return [long]0
}

function Read-LogFrom([long]$From) {
    if (-not (Test-Path $logPath)) { return '' }
    try {
        $bytes = [IO.File]::ReadAllBytes($logPath)
    }
    catch {
        return ''   # the host appends atomically but may hold the file for a moment
    }
    if ($From -ge $bytes.Length) { return '' }
    return [Text.Encoding]::UTF8.GetString($bytes, [int]$From, [int]($bytes.Length - $From))
}

function Wait-LogLine {
    param(
        [long]$Offset,
        [string]$Pattern,
        [int]$TimeoutSeconds = 20,
        [string]$Label = 'log line'
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $text = ''
    do {
        $text = Read-LogFrom $Offset
        if ($text -match $Pattern) {
            $line = ($text -split "`r?`n" | Where-Object { $_ -match $Pattern } | Select-Object -First 1).Trim()
            Pass $Label $line
            return $true
        }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)

    Fail $Label "pattern not found within ${TimeoutSeconds}s: $Pattern"
    Write-LogTail $Offset
    return $false
}

function Wait-Window {
    param([System.Diagnostics.Process]$Process, [int]$TimeoutSeconds = 25)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ($Process.HasExited) { return [IntPtr]::Zero }
        $Process.Refresh()
        if ($Process.MainWindowHandle -ne [IntPtr]::Zero) { return $Process.MainWindowHandle }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    return [IntPtr]::Zero
}

# ---------------------------------------------------------------- host lifecycle

function Get-ScenarioPage {
    param([string]$Scenario, [switch]$Plain)
    if ($Plain) { return $devtestDir }

    $source = Join-Path $devtestDir 'index.html'
    if (-not (Test-Path $source)) { throw "devtest page missing: $source" }

    $target = Join-Path $workRoot $Scenario
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    $html = [IO.File]::ReadAllText($source)
    # The real page reads ?auto= from the URL; the virtual-host mapping has no query
    # string, so the self-test bakes the scenario into a copy of the page instead.
    $pattern = "new URLSearchParams\(location\.search\)\.get\('auto'\)"
    $count = ([regex]::Matches($html, $pattern)).Count
    if ($count -ne 1) { throw "devtest page no longer matches the expected auto-scenario hook ($count matches)" }
    $html = [regex]::Replace($html, $pattern, "'$Scenario'")
    [IO.File]::WriteAllText((Join-Path $target 'index.html'), $html)
    return $target
}

function Move-CursorToPrimaryCenter {
    # WindowStartupLocation=CenterScreen centers the window on the monitor that currently holds
    # the mouse, so on a multi-monitor desk the launch rect depends on where the user left the
    # pointer. Pin it to the primary monitor to keep every rect assertion deterministic.
    $moved = $false
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $primary = [System.Windows.Forms.Screen]::PrimaryScreen
        if ($null -ne $primary) {
            $bounds = $primary.Bounds
            $moved = [Win32]::SetCursorPos(
                [int]($bounds.X + [math]::Floor($bounds.Width / 2)),
                [int]($bounds.Y + [math]::Floor($bounds.Height / 2)))
        }
    }
    catch {
        Write-Host "       cursor pin via WinForms failed: $($_.Exception.Message)"
    }
    if (-not $moved) { [void][Win32]::SetCursorPos(600, 400) }
}

function Start-TestHost {
    param([string]$WebDir, [switch]$NoContent)

    # Isolate every scenario from env vars inherited from a previous test run in the same shell.
    Get-ChildItem Env: -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'ZILUX2_*' } |
        ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue }
    if (-not $NoContent) { $env:ZILUX2_WEB_DIR = $WebDir }

    Move-CursorToPrimaryCenter
    $offset = Get-LogLength
    $process = Start-Process -FilePath $exe -PassThru -WorkingDirectory $repoRoot
    $script:Child = $process
    Write-Host ("`n=== host started pid={0} webDir={1}" -f $process.Id, $(if ($NoContent) { '<none>' } else { $WebDir }))
    return [pscustomobject]@{ Process = $process; LogOffset = $offset }
}

function Close-TestHost {
    # -Host would collide with PowerShell's read-only $Host automatic variable.
    param($Session, [IntPtr]$Hwnd, [switch]$ExpectGraceful)
    $process = $Session.Process
    if (-not $process.HasExited) {
        if ($Hwnd -and $Hwnd -ne [IntPtr]::Zero) {
            [void][Win32]::PostMessage($Hwnd, [Win32]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
        }
        if (-not $process.WaitForExit(10000)) {
            Write-Host "       pid=$($process.Id) did not exit, killing"
            $process.Kill()
            $process.WaitForExit(5000)
            Fail 'host exits on WM_CLOSE' 'had to kill the process'
            return
        }
    }
    if ($ExpectGraceful -and $process.ExitCode -ne 0) {
        Fail 'host exits with code 0' "exit code $($process.ExitCode)"
    }
    else {
        Pass 'host exits' "code=$($process.ExitCode)"
    }
}

function Get-Rect([IntPtr]$Hwnd) {
    $rect = New-Object Win32+RECT
    [void][Win32]::GetWindowRect($Hwnd, [ref]$rect)
    return [pscustomobject]@{
        Left = $rect.Left; Top = $rect.Top; Right = $rect.Right; Bottom = $rect.Bottom
        Width = $rect.Right - $rect.Left; Height = $rect.Bottom - $rect.Top
    }
}

function Format-Rect($Rect) {
    return ("left={0} top={1} size={2}x{3}" -f $Rect.Left, $Rect.Top, $Rect.Width, $Rect.Height)
}

function Get-Scale([IntPtr]$Hwnd) {
    $dpi = [Win32]::GetDpiForWindow($Hwnd)
    if (-not $dpi) { return 1.0 }
    return [double]$dpi / 96.0
}

function Click-Drag {
    param([int]$StartX, [int]$StartY, [int]$StepX, [int]$StepY, [int]$Steps = 10, [int]$DelayMs = 45)
    [void][Win32]::SetCursorPos($StartX, $StartY)
    Start-Sleep -Milliseconds 150
    [Win32]::mouse_event([Win32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    for ($i = 0; $i -lt $Steps; $i++) {
        [Win32]::mouse_event([Win32]::MOUSEEVENTF_MOVE, $StepX, $StepY, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds $DelayMs
    }
    [Win32]::mouse_event([Win32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
}

function Test-LogMatch {
    # Non-failing wait used by adaptive checks that retry instead of asserting once.
    param([long]$Offset, [string]$Pattern, [int]$TimeoutSeconds = 6)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if ((Read-LogFrom $Offset) -match $Pattern) { return $true }
        Start-Sleep -Milliseconds 120
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Get-WorkArea([IntPtr]$Hwnd) {
    $monitor = [Win32]::MonitorFromWindow($Hwnd, [Win32]::MONITOR_DEFAULTTONEAREST)
    $info = New-Object Win32+MONITORINFO
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
    [void][Win32]::GetMonitorInfo($monitor, [ref]$info)
    return $info.rcWork
}

function Invoke-EdgeResize {
    # WindowChrome exposes an 8 DIP resize band around the WebView2 area; drag from just inside
    # the outer edge and report the resulting size delta.
    param([IntPtr]$Hwnd, [ValidateSet('Left', 'Right', 'Bottom')][string]$Edge, [int]$Amount = 144)
    $scale = Get-Scale $Hwnd
    $before = Get-Rect $Hwnd
    $work = Get-WorkArea $Hwnd
    # Keep the gesture inside the work area: when the window bottom is pushed under the taskbar
    # (or the right edge past the screen) Windows turns the release into an OS snap instead of a
    # plain resize, which would test the OS rather than the host's resize band.
    switch ($Edge) {
        'Left' { $room = $before.Left - $work.Left - 16 }
        'Right' { $room = $work.Right - $before.Right - 16 }
        'Bottom' { $room = $work.Bottom - $before.Bottom - 16 }
    }
    if ($room -lt 48) { $room = 48 }
    if ($Amount -gt $room) { $Amount = $room }
    $steps = [int][math]::Ceiling($Amount / 12)
    switch ($Edge) {
        'Left' {
            $sx = $before.Left + 3
            $sy = $before.Top + [int]($before.Height / 2)
            $stepX = -12; $stepY = 0
        }
        'Right' {
            $sx = $before.Right - 3
            $sy = $before.Top + [int]($before.Height / 2)
            $stepX = 12; $stepY = 0
        }
        'Bottom' {
            $sx = $before.Left + [int]($before.Width / 2)
            $sy = $before.Bottom - 3
            $stepX = 0; $stepY = 12
        }
    }
    Click-Drag -StartX $sx -StartY $sy -StepX $stepX -StepY $stepY -Steps $steps
    $deadline = (Get-Date).AddSeconds(6)
    do {
        $after = Get-Rect $Hwnd
        if ($Edge -eq 'Bottom') { $delta = $after.Height - $before.Height }
        else { $delta = $after.Width - $before.Width }
        if ([math]::Abs($delta) -ge [int]($Amount / 2)) { break }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    Write-Host ("       resize {0,-6}: {1} -> {2} delta={3} (asked {4})" -f $Edge, (Format-Rect $before), (Format-Rect $after), $delta, $Amount)
    return [pscustomobject]@{ Before = $before; After = $after; Delta = $delta; Scale = $scale }
}

# ---------------------------------------------------------------- preflight

Write-Host "Zilux2 host self-test"
Write-Host "repo: $repoRoot"
Write-Host "log:  $logPath"

if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build.ps1') -Configuration $Configuration
}
Check (Test-Path $exe) 'host executable exists' $exe

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'Zilux2\logs') -Force | Out-Null

try {
    # ------------------------------------------------------------ 1: startup, page load, drag, resize
    Write-Host "`n--- scenario: startup / navigation / drag / resize"

    $host1 = Start-TestHost -WebDir $devtestDir
    $hwnd1 = Wait-Window $host1.Process
    Check ($hwnd1 -ne [IntPtr]::Zero) 'main window appears' "hwnd=$hwnd1"
    Check ([Win32]::IsWindowVisible($hwnd1)) 'main window is visible'

    if ($hwnd1 -eq [IntPtr]::Zero) { throw 'no main window; aborting window tests' }

    [void](Wait-LogLine $host1.LogOffset 'webview2 initialized' 40 'webview2 initialized')
    [void](Wait-LogLine $host1.LogOffset 'navigation completed: success=True' 40 'navigation completed')
    [void](Wait-LogLine $host1.LogOffset 'page\.ready' 20 'page announced ready')
    [void](Wait-LogLine $host1.LogOffset 'web:info hostmsg .*"event":"ready"' 20 'page received host ready message')
    [void](Wait-LogLine $host1.LogOffset 'devtest page loaded' 20 'devtest page loaded')
    [void](Wait-LogLine $host1.LogOffset '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[' 5 'log lines are timestamped')

    Check (Test-Path (Join-Path $env:LOCALAPPDATA 'Zilux2\WebView2')) 'WebView2 user data folder is outside the app dir'
    Check ((Read-LogFrom $host1.LogOffset) -match 'webview2 environment creating: udf=.*Zilux2\\WebView2') 'WebView2 UDF path logged'

    $title = New-Object Text.StringBuilder 256
    [void][Win32]::GetWindowText($hwnd1, $title, 256)
    Check ($title.ToString() -eq 'Zilux2') 'window title is Zilux2' "title='$($title.ToString())'"

    $rect = Get-Rect $hwnd1
    Write-Host "       initial window: $(Format-Rect $rect), dpi scale $(Get-Scale $hwnd1)"
    Check ($rect.Width -ge 1100 -and $rect.Height -ge 700) 'window at least 1100x700' (Format-Rect $rect)

    # Drag: the page title bar sends {"type":"drag"}; the host hands the pointer to the OS move loop.
    # Retry once: on a busy desktop the first click after launch can be spent activating the window.
    $dragPattern = 'page\.drag: handing pointer to the OS move loop'
    $dragOk = $false
    for ($attempt = 1; $attempt -le 2 -and -not $dragOk; $attempt++) {
        [void][Win32]::SetForegroundWindow($hwnd1)
        Start-Sleep -Milliseconds 300
        $scale = Get-Scale $hwnd1
        $before = Get-Rect $hwnd1
        $dragX = $before.Left + [int]((300 + 40 * ($attempt - 1)) * $scale)
        $dragY = $before.Top + [int](26 * $scale)   # inside the 48 DIP page title bar, outside the 8 DIP resize band
        Click-Drag -StartX $dragX -StartY $dragY -StepX 14 -StepY 6 -Steps 10
        $after = Get-Rect $hwnd1
        Write-Host "       drag attempt ${attempt}: $(Format-Rect $before) -> $(Format-Rect $after)"
        $moved = ($after.Left -ge $before.Left + 60) -and ($after.Top -ge $before.Top + 20)
        $logged = Test-LogMatch $host1.LogOffset $dragPattern 6
        $dragOk = $moved -and $logged
    }
    Check $dragOk 'page drag message moved the window' "dx=$($after.Left - $before.Left) dy=$($after.Top - $before.Top)"

    # Resize: grab the 8 DIP WPF-owned border strip (WebView2 must not swallow it).
    $leftResize = Invoke-EdgeResize -Hwnd $hwnd1 -Edge Left
    Check ($leftResize.Delta -ge 80) 'left edge drag resized the window' "width +$($leftResize.Delta)"
    $rightResize = Invoke-EdgeResize -Hwnd $hwnd1 -Edge Right
    Check ($rightResize.Delta -ge 60) 'right edge drag resized the window' "width +$($rightResize.Delta)"
    $bottomResize = Invoke-EdgeResize -Hwnd $hwnd1 -Edge Bottom
    Check ($bottomResize.Delta -ge 60) 'bottom edge drag resized the window' "height +$($bottomResize.Delta)"

    # Off-screen guard A: drag straight down; the host must keep the title bar inside the work
    # area instead of letting a page-driven drag park the window head first below the taskbar.
    [void][Win32]::SetForegroundWindow($hwnd1)
    Start-Sleep -Milliseconds 300
    $scale = Get-Scale $hwnd1
    $work = Get-WorkArea $hwnd1
    $clampStart = Get-Rect $hwnd1
    $clampStartX = $clampStart.Left + [int](320 * $scale)
    $clampStartY = $clampStart.Top + [int](26 * $scale)
    Click-Drag -StartX $clampStartX -StartY $clampStartY -StepX 0 -StepY 250 -Steps 8 -DelayMs 35
    Start-Sleep -Milliseconds 500
    $clamped = Get-Rect $hwnd1
    $titleBarBottom = $clamped.Top + [int](56 * $scale)
    Write-Host "       downward drag: $(Format-Rect $clamped); work=left=$($work.Left) top=$($work.Top) right=$($work.Right) bottom=$($work.Bottom)"
    Check (($clamped.Left -ne $clampStart.Left) -or ($clamped.Top -ne $clampStart.Top)) 'window moved before the off-screen clamp kicked in' "$(Format-Rect $clamped)"
    Check (($titleBarBottom -le $work.Bottom + 4) -and ($clamped.Top -ge $work.Top - 4) -and
           ($clamped.Top -le $work.Bottom - [int](56 * $scale) + 8)) 'dragging down keeps the title bar reachable' "titleBarBottom=$titleBarBottom top=$($clamped.Top)"

    # Off-screen guard B: push the window far right; the OS may snap it, the host may clamp it,
    # either way a horizontal slice must stay inside the work area.
    $clampStart2 = Get-Rect $hwnd1
    $clampStartX2 = $clampStart2.Left + [int](320 * $scale)
    $clampStartY2 = $clampStart2.Top + [int](26 * $scale)
    Click-Drag -StartX $clampStartX2 -StartY $clampStartY2 -StepX 400 -StepY 0 -Steps 8 -DelayMs 35
    Start-Sleep -Milliseconds 500
    $clamped2 = Get-Rect $hwnd1
    Write-Host "       rightward drag: $(Format-Rect $clamped2)"
    Check (($clamped2.Left -le $work.Right - [int](150 * $scale)) -and
           ($clamped2.Right -ge $work.Left + [int](150 * $scale))) 'pushing the window right keeps part of it reachable' (Format-Rect $clamped2)

    Close-TestHost -Session $host1 -Hwnd $hwnd1 -ExpectGraceful
    [void](Wait-LogLine $host1.LogOffset 'window\.closed' 10 'window.closed logged')

    # ------------------------------------------------------------ 2: page-driven maximize / restore
    Write-Host "`n--- scenario: page-driven toggleMaximize"
    $maxDir = Get-ScenarioPage 'maximize'
    $host2 = Start-TestHost -WebDir $maxDir
    $hwnd2 = Wait-Window $host2.Process
    Check ($hwnd2 -ne [IntPtr]::Zero) 'maximize scenario window appears' "hwnd=$hwnd2"
    if ($hwnd2 -ne [IntPtr]::Zero) {
        [void](Wait-LogLine $host2.LogOffset 'window\.action toggleMaximize' 20 'page toggleMaximize received')
        [void](Wait-LogLine $host2.LogOffset 'window\.state maximized=True' 20 'maximized state logged')
        [void](Wait-LogLine $host2.LogOffset 'web:info hostmsg .*"event":"windowState".*"maximized":true' 20 'page received maximized windowState push')
        Start-Sleep -Milliseconds 400
        Check ([Win32]::IsZoomed($hwnd2)) 'window is maximized'
        $maxRect = Get-Rect $hwnd2
        $monitor = [Win32]::MonitorFromWindow($hwnd2, [Win32]::MONITOR_DEFAULTTONEAREST)
        $info = New-Object Win32+MONITORINFO
        $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
        [void][Win32]::GetMonitorInfo($monitor, [ref]$info)
        $work = $info.rcWork
        $workWidth = $work.Right - $work.Left
        $workHeight = $work.Bottom - $work.Top
        Write-Host "       maximized: $(Format-Rect $maxRect); work area: left=$($work.Left) top=$($work.Top) size=${workWidth}x${workHeight}"
        # A borderless window without WM_GETMINMAXINFO clamping grows over the taskbar; the work
        # area bound is what proves the clamp is in effect.
        Check (($maxRect.Left -le $work.Left + 2) -and ($maxRect.Top -le $work.Top + 2) -and
               ($maxRect.Width -ge $workWidth - 20) -and ($maxRect.Width -le $workWidth + 40) -and
               ($maxRect.Height -le $workHeight + 40)) 'maximized window is clamped to the monitor work area' (Format-Rect $maxRect)
        [void](Wait-LogLine $host2.LogOffset 'window\.state maximized=False' 20 'restored state logged')
        Start-Sleep -Milliseconds 400
        Check (-not [Win32]::IsZoomed($hwnd2)) 'window restored after second toggle'
        Close-TestHost -Session $host2 -Hwnd $hwnd2 -ExpectGraceful
    }
    else {
        Close-TestHost -Session $host2 -Hwnd ([IntPtr]::Zero)
    }

    # ------------------------------------------------------------ 3: double-click (drag + toggleMaximize race)
    Write-Host "`n--- scenario: double-click maximize"
    $doubleDir = Get-ScenarioPage 'double'
    $hostDouble = Start-TestHost -WebDir $doubleDir
    $hwndDouble = Wait-Window $hostDouble.Process
    Check ($hwndDouble -ne [IntPtr]::Zero) 'double-click scenario window appears' "hwnd=$hwndDouble"
    if ($hwndDouble -ne [IntPtr]::Zero) {
        [void](Wait-LogLine $hostDouble.LogOffset 'window\.action toggleMaximize' 20 'double click toggleMaximize received')
        [void](Wait-LogLine $hostDouble.LogOffset 'window\.state maximized=True' 20 'double click maximized the window')
        Start-Sleep -Milliseconds 600
        Check ([Win32]::IsZoomed($hwndDouble)) 'window stays maximized after the double-click drag race'
        [void](Wait-LogLine $hostDouble.LogOffset 'window\.state maximized=False' 20 'second double click restored the window')
        Start-Sleep -Milliseconds 600
        Check (-not [Win32]::IsZoomed($hwndDouble)) 'window is not maximized after the second double click'
        Close-TestHost -Session $hostDouble -Hwnd $hwndDouble -ExpectGraceful
        [void](Wait-LogLine $hostDouble.LogOffset 'window\.closed' 10 'window.closed logged after double-click scenario')
    }
    else {
        Close-TestHost -Session $hostDouble -Hwnd ([IntPtr]::Zero)
    }

    # ------------------------------------------------------------ 4: page-driven minimize
    Write-Host "`n--- scenario: page-driven minimize"
    $minDir = Get-ScenarioPage 'minimize'
    $host3 = Start-TestHost -WebDir $minDir
    $hwnd3 = Wait-Window $host3.Process
    Check ($hwnd3 -ne [IntPtr]::Zero) 'minimize scenario window appears' "hwnd=$hwnd3"
    if ($hwnd3 -ne [IntPtr]::Zero) {
        [void](Wait-LogLine $host3.LogOffset 'window\.action minimize' 20 'page minimize received')
        Start-Sleep -Milliseconds 700
        Check ([Win32]::IsIconic($hwnd3)) 'window is minimized'
        [void][Win32]::ShowWindow($hwnd3, [Win32]::SW_RESTORE)
        Start-Sleep -Milliseconds 700
        Check (-not [Win32]::IsIconic($hwnd3)) 'window restored from taskbar'
        Close-TestHost -Session $host3 -Hwnd $hwnd3 -ExpectGraceful
    }
    else {
        Close-TestHost -Session $host3 -Hwnd ([IntPtr]::Zero)
    }

    # ------------------------------------------------------------ 5: page-driven close
    Write-Host "`n--- scenario: page-driven close"
    $closeDir = Get-ScenarioPage 'close'
    $host4 = Start-TestHost -WebDir $closeDir
    $hwnd4 = Wait-Window $host4.Process
    Check ($hwnd4 -ne [IntPtr]::Zero) 'close scenario window appears' "hwnd=$hwnd4"
    $exited = $host4.Process.WaitForExit(20000)
    Check $exited 'process exits after page close message'
    if ($exited) {
        Check ($host4.Process.ExitCode -eq 0) 'close exits with code 0' "code=$($host4.Process.ExitCode)"
    }
    [void](Wait-LogLine $host4.LogOffset 'window\.action close' 10 'page close received')
    [void](Wait-LogLine $host4.LogOffset 'window\.closed dispose begin' 10 'WebView2 disposal started')
    [void](Wait-LogLine $host4.LogOffset 'window\.closed dispose end' 10 'WebView2 disposal finished before process exit')
    [void](Wait-LogLine $host4.LogOffset 'webview2\.disposed' 10 'webview2 disposed')
    [void](Wait-LogLine $host4.LogOffset 'window\.closed' 10 'window.closed logged after page close')
    if (-not $exited) { Close-TestHost -Session $host4 -Hwnd $hwnd4 }

    # ------------------------------------------------------------ 6: no front-end content
    Write-Host "`n--- scenario: missing front-end content"

    # build.ps1 ships web\dist next to the exe when it exists; hide it so the
    # "nothing to load" branch is actually reached.
    $bundledWeb = Join-Path $outDir 'web'
    $hiddenWeb = Join-Path $outDir 'web.__selftest_hidden'
    $bundledHidden = $false
    if (Test-Path $bundledWeb) {
        if (Test-Path $hiddenWeb) { Remove-Item -Recurse -Force $hiddenWeb }
        Move-Item -Path $bundledWeb -Destination $hiddenWeb
        $bundledHidden = $true
    }

    try {
        $host5 = Start-TestHost -NoContent
        $hwnd5 = Wait-Window $host5.Process 15
        Check ($hwnd5 -ne [IntPtr]::Zero) 'no-content dialog appears instead of a blank window' "hwnd=$hwnd5"
        [void](Wait-LogLine $host5.LogOffset 'host\.start without content' 10 'missing content logged')
        if ($hwnd5 -ne [IntPtr]::Zero) {
            $dialogTitle = New-Object Text.StringBuilder 256
            [void][Win32]::GetWindowText($hwnd5, $dialogTitle, 256)
            Check ($dialogTitle.ToString() -like 'Zilux2*') 'no-content dialog is titled for the user' "title='$($dialogTitle.ToString())'"
            [void][Win32]::PostMessage($hwnd5, [Win32]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
        }
        $exited5 = $host5.Process.WaitForExit(10000)
        Check $exited5 'no-content process exits after dismissing the dialog'
        if ($exited5) {
            Check ($host5.Process.ExitCode -eq 2) 'no-content exit code is 2' "code=$($host5.Process.ExitCode)"
        }
        if (-not $exited5) { Close-TestHost -Session $host5 -Hwnd $hwnd5 }
    }
    finally {
        if ($bundledHidden -and (Test-Path $hiddenWeb)) {
            if (Test-Path $bundledWeb) { Remove-Item -Recurse -Force $bundledWeb }
            Move-Item -Path $hiddenWeb -Destination $bundledWeb
        }
    }
}
finally {
    if ($script:Child -and -not $script:Child.HasExited) {
        Write-Host "cleaning up pid=$($script:Child.Id)"
        $script:Child.Kill()
    }
    Get-ChildItem Env: -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'ZILUX2_*' } |
        ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- summary

Write-Host "`n================ self-test summary ================"
Write-Host "passed: $($script:Passes)"
Write-Host "failed: $($script:Failures.Count)"
if ($script:Failures.Count -gt 0) {
    foreach ($failure in $script:Failures) { Write-Host "  - $failure" -ForegroundColor Red }
    exit 1
}
Write-Host 'all checks passed'
foreach ($line in $script:Evidence) { Write-Host "  * $line" }
Write-Host 'log file:'
Write-Host "  $logPath"
exit 0
