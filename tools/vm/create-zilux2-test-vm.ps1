# Create the Zilux2 driver test VM (run after Hyper-V is enabled and host rebooted).
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\vm\create-zilux2-test-vm.ps1 \
#       -IsoPath 'E:\Win11_25H2_Pro_Chinese_Simplified_x64.iso'

param(
    [string]$IsoPath = 'E:\Win11_25H2_Pro_Chinese_Simplified_x64.iso',
    [string]$VmRoot = 'E:\Zilux2VM',
    [string]$VmName = 'Zilux2DriverTest',
    [int]$MemoryGB = 6,
    [int]$CpuCount = 4,
    [int]$DiskGB = 80
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script as Administrator.'
}
if (-not (Test-Path $IsoPath)) { throw "ISO not found: $IsoPath" }
if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) {
    throw 'Hyper-V PowerShell module not available. Enable Microsoft-Hyper-V-All and reboot.'
}

New-Item -ItemType Directory -Force -Path $VmRoot | Out-Null
$vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
if ($vm) {
    if ($vm.State -ne 'Off') { Stop-VM -Name $VmName -Force -TurnOff }
    Remove-VM -Name $VmName -Force
}

$vhd = Join-Path $VmRoot "$VmName.vhdx"
if (Test-Path $vhd) { Remove-Item $vhd -Force }

$switch = Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue
if (-not $switch) {
    throw "Hyper-V 'Default Switch' not found. Create an external/default switch first."
}

New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) `
    -NewVHDPath $vhd -NewVHDSizeBytes ($DiskGB * 1GB) -SwitchName 'Default Switch' | Out-Null
Set-VMProcessor -VMName $VmName -Count $CpuCount
Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $true -MinimumBytes 2GB -MaximumBytes ($MemoryGB * 1GB)
# Test-signed drivers: disable Secure Boot inside the VM.
Set-VMSecurity -VMName $VmName -SecureBootEnabled $false
Add-VMDvdDrive -VMName $VmName -Path $IsoPath
$dvd = Get-VMDvdDrive -VMName $VmName
Set-VMFirmware -VMName $VmName -FirstBootDevice $dvd
Start-VM -Name $VmName
Write-Host "VM '$VmName' started. Connect with: vmconnect.exe localhost $VmName"
Write-Host "Windows Setup will run from $IsoPath."
