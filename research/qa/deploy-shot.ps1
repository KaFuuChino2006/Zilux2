# Rebuild web front end, deploy to portable app, restart it and capture a screenshot.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File research/qa/deploy-shot.ps1 -Out <png path> [-NoBuild]
param(
    [string]$Out = 'E:\Zilux2开发\research\shots\now.png',
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$root = 'E:\Zilux2开发'
$env:Path = 'C:\Users\13329\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;' + $env:Path

if (-not $NoBuild) {
    Push-Location "$root\web"
    try {
        & node ./node_modules/vite/bin/vite.js build | Select-Object -Last 6 | ForEach-Object { Write-Output $_ }
        if ($LASTEXITCODE -ne 0) { throw "vite build failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

$src = "$root\web\dist"
$dst = "$root\dist\Zilux2\web"

Get-Process Zilux2 -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

Remove-Item "$dst\assets" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$src\assets" -Destination "$dst\assets" -Recurse -Force
Copy-Item "$src\index.html" -Destination "$dst\index.html" -Force

Start-Process "$root\dist\Zilux2\Zilux2.exe"
Start-Sleep -Seconds 6

& powershell -NoProfile -ExecutionPolicy Bypass -File "$root\research\qa\shot-now.ps1" -Out $Out
