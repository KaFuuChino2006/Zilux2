#requires -Version 7
<#
  fetch-model.ps1 — download the HTDemucs ONNX export used by the stems prototype.

  Model : htdemucs-dft-fp16-transparent.onnx
  Source: https://huggingface.co/itamiArika/htdemucs-int8-memory  (MIT)
          mirror: https://hf-mirror.com/... because huggingface.co is unreachable here
  I/O   : mix  (1,2,343980) float32 @ 44100 Hz stereo  ->  stems (1,4,2,343980)
          order: drums, bass, other, vocals

  The sha256 below is copied from the repo's SHA256SUMS file and is verified after
  download; a mismatch aborts.
#>

[CmdletBinding()]
param(
    [string] $OutDir = (Join-Path $PSScriptRoot 'models'),
    [string] $File   = 'htdemucs-dft-fp16-transparent.onnx',
    [string] $Sha256 = '10d0d51c78f5ed1bc8e2c7b47f816169e810d78e4ebd510369c4a6a2b362221e',
    [string] $Base   = 'https://hf-mirror.com/itamiArika/htdemucs-int8-memory/resolve/main'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$dest = Join-Path $OutDir $File

if (Test-Path $dest) {
    $have = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLowerInvariant()
    if ($have -eq $Sha256) { Write-Host "already present + verified: $dest"; return }
    Write-Host "existing file hash mismatch, re-downloading"
    Remove-Item $dest -Force
}

# No query string: PowerShell would fold "?download" into the variable name.
$url = $Base + '/' + $File
Write-Host "GET $url"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
# curl.exe handles the mirror's redirect dance and resume better than IWR here.
& curl.exe -L --fail --retry 3 --retry-delay 2 -o $dest $url
if ($LASTEXITCODE -ne 0) { throw "curl failed with exit $LASTEXITCODE" }
$sw.Stop()

$len = (Get-Item $dest).Length
Write-Host ("downloaded {0:N0} bytes in {1:N1}s ({2:N2} MB/s)" -f $len, $sw.Elapsed.TotalSeconds, ($len / 1MB / $sw.Elapsed.TotalSeconds))

$got = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLowerInvariant()
if ($got -ne $Sha256) {
    throw "SHA256 mismatch`n  expected $Sha256`n  actual   $got"
}
Write-Host "sha256 OK  $got"
