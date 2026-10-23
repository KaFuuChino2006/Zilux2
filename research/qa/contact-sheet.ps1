# Compose the 8 variant screenshots into a 2x4 contact sheet (ASCII-only, PS 5.1 safe).
param(
    [string]$ShotsDir = (Join-Path $PSScriptRoot '..\shots'),
    [string]$OutName = 'tmv-sheet.png'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$cellW = 620
$cellH = 341
$cols = 2
$rows = 4
$sheet = New-Object System.Drawing.Bitmap ($cellW * $cols), ($cellH * $rows)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear([System.Drawing.Color]::FromArgb(10, 10, 14))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(80, 230, 193, 132)), 1

for ($i = 1; $i -le 8; $i++) {
    $file = Join-Path $ShotsDir ('tmv-{0}.png' -f $i)
    if (-not (Test-Path $file)) { throw "missing $file" }
    $img = [System.Drawing.Image]::FromFile($file)
    $col = ($i - 1) % $cols
    $row = [math]::Floor(($i - 1) / $cols)
    $x = $col * $cellW
    $y = $row * $cellH
    $g.DrawImage($img, $x, $y, $cellW, $cellH)
    $g.DrawRectangle($pen, $x, $y, $cellW - 1, $cellH - 1)
    $img.Dispose()
}
$pen.Dispose()
$g.Dispose()
$out = Join-Path $ShotsDir $OutName
$sheet.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()
Write-Output ("sheet {0} {1} bytes" -f $out, (Get-Item $out).Length)
