param(
    [string]$CommandFile = 'E:\Zilux2开发\.scratch\vm-input-cmd.txt',
    [int]$VmConsolePid = 17936
)

$ErrorActionPreference = 'SilentlyContinue'
$log = 'E:\Zilux2开发\.scratch\vm-input-agent.log'
"agent start pid=$PID console=$VmConsolePid $(Get-Date -Format o)" | Set-Content $log -Encoding utf8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VmInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
Add-Type -AssemblyName System.Windows.Forms

function Focus-Console {
    $p = Get-Process -Id $VmConsolePid -ErrorAction SilentlyContinue
    if ($p) {
        [VmInput]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
        [VmInput]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    }
}

Focus-Console
for ($i = 0; $i -lt 3600; $i++) {
    if (-not (Test-Path $CommandFile)) { Start-Sleep -Milliseconds 300; continue }
    $lines = @(Get-Content $CommandFile -Encoding utf8 -ErrorAction SilentlyContinue)
    if ($lines.Count -eq 0) { Start-Sleep -Milliseconds 300; continue }
    Remove-Item $CommandFile -Force -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
        $line = $line.Trim()
        if (-not $line) { continue }
        "cmd: $line" | Add-Content $log -Encoding utf8
        if ($line -match '^exit$') {
            'exit' | Add-Content $log -Encoding utf8
            return
        }
        if ($line -match '^focus$') {
            Focus-Console
            Start-Sleep -Milliseconds 300
            continue
        }
        if ($line -match '^click\s+(\d+)\s+(\d+)$') {
            Focus-Console
            [VmInput]::SetCursorPos([int]$Matches[1], [int]$Matches[2]) | Out-Null
            Start-Sleep -Milliseconds 150
            [VmInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            [VmInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 400
            continue
        }
        if ($line -match '^key\s+(.+)$') {
            Focus-Console
            [System.Windows.Forms.SendKeys]::SendWait($Matches[1])
            Start-Sleep -Milliseconds 400
            continue
        }
        if ($line -match '^text\s+(.+)$') {
            Focus-Console
            [System.Windows.Forms.SendKeys]::SendWait($Matches[1])
            Start-Sleep -Milliseconds 300
            continue
        }
        if ($line -match '^sleep\s+(\d+)$') {
            Start-Sleep -Milliseconds ([int]$Matches[1])
            continue
        }
    }
    'ok' | Add-Content $log -Encoding utf8
}
