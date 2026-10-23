# Mean luminance of a rectangle in a PNG (used to compare preview renders).
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$X = 925,
    [int]$Y = 262,
    [int]$W = 437,
    [int]$H = 250
)

Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($Path)
$sum = 0.0
$count = 0
for ($py = $Y; $py -lt [Math]::Min($Y + $H, $bmp.Height); $py += 3) {
    for ($px = $X; $px -lt [Math]::Min($X + $W, $bmp.Width); $px += 3) {
        $c = $bmp.GetPixel($px, $py)
        $sum += (0.2126 * $c.R + 0.7152 * $c.G + 0.0722 * $c.B)
        $count++
    }
}
$bmp.Dispose()
Write-Output ("{0} mean={1:N2} samples={2}" -f (Split-Path $Path -Leaf), ($sum / [Math]::Max(1, $count)), $count)
