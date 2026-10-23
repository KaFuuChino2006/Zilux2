# Analyze brightness of screenshot lyric area: reports avg/min/max/std of a coarse grid.
param([string[]]$Files)
Add-Type -AssemblyName System.Drawing

foreach ($f in $Files) {
    $bmp = [System.Drawing.Bitmap]::FromFile($f)
    try {
        $x0 = [int]($bmp.Width * 0.33)
        $x1 = [int]($bmp.Width * 0.97)
        $y0 = [int]($bmp.Height * 0.06)
        $y1 = [int]($bmp.Height * 0.92)
        $vals = New-Object System.Collections.Generic.List[double]
        $step = 24
        for ($x = $x0; $x -lt $x1; $x += $step) {
            for ($y = $y0; $y -lt $y1; $y += $step) {
                $c = $bmp.GetPixel($x, $y)
                $vals.Add((($c.R + $c.G + $c.B) / 3.0))
            }
        }
        $avg = ($vals | Measure-Object -Average).Average
        $min = ($vals | Measure-Object -Minimum).Minimum
        $max = ($vals | Measure-Object -Maximum).Maximum
        $sum = 0.0
        foreach ($v in $vals) { $sum += [math]::Pow($v - $avg, 2) }
        $std = [math]::Sqrt($sum / $vals.Count)
        $name = [System.IO.Path]::GetFileName($f)
        '{0,-26} avg={1,6:N1} min={2,5:N0} max={3,5:N0} std={4,5:N1} brightest={5,6:N1}' -f $name, $avg, $min, $max, $std, ($vals | Measure-Object -Maximum).Maximum
    }
    finally { $bmp.Dispose() }
}
