#Requires -Version 5.1
<#
.SYNOPSIS
    Creates convenient launch shortcuts for the published Zilux2 build.
.DESCRIPTION
    Desktop shortcut "Zilux2" (default) and optionally a Start Menu entry.
    Points at dist\Zilux2\Zilux2.exe; run tools\publish.ps1 first.
#>
[CmdletBinding()]
param(
    [string]$Exe,
    [switch]$StartMenu,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Exe) { $Exe = Join-Path $repoRoot 'dist\Zilux2\Zilux2.exe' }
$Exe = [IO.Path]::GetFullPath($Exe)

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startPrograms = [Environment]::GetFolderPath('Programs')
$desktopLnk = Join-Path $desktop 'Zilux2.lnk'
$startLnk = Join-Path (Join-Path $startPrograms 'Zilux2') 'Zilux2.lnk'

if ($Remove) {
    Remove-Item $desktopLnk -ErrorAction SilentlyContinue
    Remove-Item (Split-Path $startLnk -Parent) -Recurse -ErrorAction SilentlyContinue
    Write-Host 'shortcuts removed'
    return
}

if (-not (Test-Path $Exe)) {
    throw "exe not found: $Exe (run tools\publish.ps1 first)"
}

function New-ZiluxShortcut([string]$Path) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Exe
    $lnk.WorkingDirectory = Split-Path $Exe -Parent
    $lnk.IconLocation = "$Exe,0"
    $lnk.Description = 'Zilux2 沉浸式音乐播放器'
    $lnk.WindowStyle = 1
    $lnk.Save()
    Write-Host "shortcut: $Path"
}

New-ZiluxShortcut $desktopLnk
if ($StartMenu) { New-ZiluxShortcut $startLnk }
Write-Host "target: $Exe"
