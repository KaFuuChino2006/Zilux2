<#
.SYNOPSIS
  One-click QA: Zilux2 "room" lyric effect inside the real WPF + WebView2 app.

.DESCRIPTION
  Flow:
    1. build web with vite (unless -NoBuild; -TypeCheck also runs tsc --noEmit)
    2. stop Zilux2, deploy web/dist -> dist/Zilux2/web (assets + index.html + fonts + any other top-level file)
    3. start dist/Zilux2/Zilux2.exe with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
    4. wait until http://127.0.0.1:9223 is reachable (max -CdpTimeoutSec seconds)
    5. run research/qa/room-app-qa.mjs (CDP: switch lumiere mode to room, reload, play a recent track,
       open lyrics page, screenshot timeline, FPS, console/exception/log collection)
    6. print a summary from research/tmp/room-app-qa.json and stop the app (unless -KeepApp)

.PARAMETER NoBuild
  Skip `vite build`. Still re-deploys the current web/dist - useful while web/src is being edited.
.PARAMETER NoDeploy
  Do not copy web/dist to dist/Zilux2/web (use an already deployed build).
.PARAMETER TypeCheck
  Run `tsc --noEmit` before `vite build` (slow; equals `npm run build`).
.PARAMETER KeepApp
  Keep the Zilux2 process running after the QA run.
.PARAMETER Times
  Screenshot time points in seconds relative to lyrics view opening. Default: "0,4,8,15,25".
.PARAMETER CdpTimeoutSec
  Max seconds to wait for the remote debugging endpoint. Default: 30.

.EXAMPLE
  pwsh -File research\qa\room-app-qa.ps1 -NoBuild

.EXAMPLE
  pwsh -File research\qa\room-app-qa.ps1 -Times "0,4,8,15,25" -KeepApp
#>
[CmdletBinding()]
param(
  [switch]$NoBuild,
  [switch]$NoDeploy,
  [switch]$TypeCheck,
  [switch]$KeepApp,
  [string]$Times = '0,4,8,15,25',
  [int]$CdpTimeoutSec = 30,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

function Write-QaStep([string]$Message) { Write-Host ('[room-app-qa] ' + $Message) }
function Write-QaWarn([string]$Message) { Write-Host ('[room-app-qa] WARN ' + $Message) -ForegroundColor Yellow }
function Write-QaError([string]$Message) { Write-Host ('[room-app-qa] ERROR ' + $Message) -ForegroundColor Red }

# Resolve project root from this script location: <repo>/research/qa -> <repo>
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
} else {
  $Root = (Resolve-Path -LiteralPath $Root).Path
}
Write-QaStep ('project root: ' + $Root)

# node from the DSH runtime bundle (same one deploy-shot.ps1 uses)
$nodeDir = 'C:\Users\13329\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin'
$nodeExe = Join-Path $nodeDir 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCmd) { throw ('node.exe not found (expected ' + $nodeExe + ')') }
  $nodeExe = $nodeCmd.Source
}
if (Test-Path -LiteralPath $nodeDir) { $env:Path = $nodeDir + ';' + $env:Path }

$webDir   = Join-Path $Root 'web'
$webDist  = Join-Path $webDir 'dist'
$appDir   = Join-Path $Root 'dist\Zilux2'
$appExe   = Join-Path $appDir 'Zilux2.exe'
$appWeb   = Join-Path $appDir 'web'
$qaScript = Join-Path $Root 'research\qa\room-app-qa.mjs'
$tmpDir   = Join-Path $Root 'research\tmp'
$jsonPath = Join-Path $tmpDir 'room-app-qa.json'
$shotsDir = Join-Path $Root 'research\shots'
$cdpUrl   = 'http://127.0.0.1:9223'

$timesArg = ($Times -replace '\s+', ',').Trim(',')
if ([string]::IsNullOrWhiteSpace($timesArg)) { $timesArg = '0,4,8,15,25' }

New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
New-Item -ItemType Directory -Force -Path $shotsDir | Out-Null

if (-not (Test-Path -LiteralPath $qaScript)) { throw ('missing QA script: ' + $qaScript) }
if (-not (Test-Path -LiteralPath $appExe)) { throw ('missing app exe: ' + $appExe) }

function Get-NodeBuildProcesses {
  try {
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
      Where-Object {
        # only real builds: `vite ... build` or `tsc --noEmit` (a vite dev server is fine and must not trip the guard)
        $_.CommandLine -and (
          $_.CommandLine -match 'vite(\.js|\.mjs)?\s+build' -or
          $_.CommandLine -match 'typescript[\\/]bin[\\/]tsc'
        )
      })
  } catch {
    @()
  }
}

function Stop-Zilux2App {
  $procs = @(Get-Process -Name 'Zilux2' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return }
  Write-QaStep ('stopping running Zilux2 (PID ' + (($procs | ForEach-Object { $_.Id }) -join ',') + ')')
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    if (@(Get-Process -Name 'Zilux2' -ErrorAction SilentlyContinue).Count -eq 0) { return }
    Start-Sleep -Milliseconds 200
  }
  throw 'Zilux2 did not exit within 10s'
}

$nodeExit = 1
$appStarted = $false

try {
  # 0) never race a running build (the Lead may be editing/building web/src right now)
  $buildProcs = Get-NodeBuildProcesses
  if ($buildProcs.Count -gt 0) {
    $pids = ($buildProcs | ForEach-Object { $_.ProcessId }) -join ','
    throw ('another vite/tsc build is active (node PID ' + $pids + '); wait for it to finish, then rerun. ' +
      'If web/src is being edited by someone else, use -NoBuild and ask before running a real build.')
  }

  # 1) build
  if (-not $NoBuild) {
    Write-QaStep 'building web (vite build) ...'
    Push-Location -LiteralPath $webDir
    try {
      if ($TypeCheck) {
        Write-QaStep 'typecheck: node ./node_modules/typescript/bin/tsc --noEmit'
        $tscLog = @(& $nodeExe '.\node_modules\typescript\bin\tsc' '--noEmit' 2>&1)
        $tscExit = $LASTEXITCODE
        $tscLog | Select-Object -Last 12 | ForEach-Object { Write-Host $_ }
        if ($tscExit -ne 0) { throw ('tsc --noEmit failed (exit ' + $tscExit + ')') }
      }
      $buildLog = @(& $nodeExe '.\node_modules\vite\bin\vite.js' 'build' 2>&1)
      $buildExit = $LASTEXITCODE
      $buildLog | Select-Object -Last 10 | ForEach-Object { Write-Host $_ }
      if ($buildExit -ne 0) { throw ('vite build failed (exit ' + $buildExit + ')') }
    } finally {
      Pop-Location
    }
    Write-QaStep 'build ok'
  } else {
    Write-QaStep 'skipping build (-NoBuild)'
  }

  # 2) stop app + deploy web/dist -> dist/Zilux2/web
  Stop-Zilux2App
  if (-not $NoDeploy) {
    $srcIndex = Join-Path $webDist 'index.html'
    $srcAssets = Join-Path $webDist 'assets'
    if (-not (Test-Path -LiteralPath $srcIndex)) { throw ('missing ' + $srcIndex) }
    if (-not (Test-Path -LiteralPath $srcAssets)) { throw ('missing ' + $srcAssets) }
    New-Item -ItemType Directory -Force -Path $appWeb | Out-Null

    # drop stale hashed bundles first, exactly like deploy-shot.ps1
    $dstAssets = Join-Path $appWeb 'assets'
    if (Test-Path -LiteralPath $dstAssets) { Remove-Item -LiteralPath $dstAssets -Recurse -Force }
    Copy-Item -LiteralPath $srcAssets -Destination $dstAssets -Recurse -Force
    Copy-Item -LiteralPath $srcIndex -Destination (Join-Path $appWeb 'index.html') -Force

    # deploy-shot.ps1 forgot fonts/ - copy every other top-level entry too
    Get-ChildItem -LiteralPath $webDist -Force | Where-Object { $_.Name -notin @('assets', 'index.html') } | ForEach-Object {
      $target = Join-Path $appWeb $_.Name
      if ($_.PSIsContainer) {
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
      } else {
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
      }
    }

    $indexHtml = Get-Content -LiteralPath (Join-Path $appWeb 'index.html') -Raw
    if ($indexHtml -match 'main-[A-Za-z0-9_-]+\.js') { Write-QaStep ('deployed main bundle: ' + $Matches[0]) }
    Write-QaStep ('deployed ' + $webDist + ' -> ' + $appWeb)
  } else {
    Write-QaStep 'skipping deploy (-NoDeploy)'
  }

  # 3) start app with the remote debugging port
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
  Write-QaStep ('starting ' + $appExe + ' with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223')
  $appProc = Start-Process -FilePath $appExe -WorkingDirectory $appDir -PassThru
  $appStarted = $true

  # 4) wait for CDP
  $deadline = (Get-Date).AddSeconds([Math]::Max(5, $CdpTimeoutSec))
  $cdpReady = $false
  $cdpVersion = $null
  while ((Get-Date) -lt $deadline) {
    if ($appProc.HasExited) { throw ('Zilux2 exited early (exit code ' + $appProc.ExitCode + ')') }
    try {
      $cdpVersion = Invoke-RestMethod -Uri ($cdpUrl + '/json/version') -TimeoutSec 2
      $cdpReady = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $cdpReady) {
    throw ('CDP endpoint ' + $cdpUrl + ' not reachable within ' + $CdpTimeoutSec + 's ' +
      '(WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS may not be honored; check the app did not reuse an existing process)')
  }
  Write-QaStep ('CDP ready: ' + ($cdpVersion | ConvertTo-Json -Compress))

  # 5) run the CDP QA pipeline
  $nodeArgs = @(
    $qaScript,
    '--endpoint', $cdpUrl,
    '--json', $jsonPath,
    '--shots-dir', $shotsDir,
    '--times', $timesArg
  )
  Write-QaStep ('running: node ' + ($nodeArgs -join ' '))
  & $nodeExe @nodeArgs
  $nodeExit = $LASTEXITCODE
} catch {
  Write-QaError $_.Exception.Message
  $nodeExit = 1
} finally {
  Write-Host ''
  Write-QaStep '================ summary ================'
  if (Test-Path -LiteralPath $jsonPath) {
    try {
      $report = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $reasonText = ''
      if ($report.reason) { $reasonText = ' (reason=' + $report.reason + ')' }
      Write-QaStep ('status: ' + $report.status + $reasonText)
      if ($report.message) { Write-QaStep ('message: ' + $report.message) }
      if ($report.target) { Write-QaStep ('target: ' + $report.target.url) }
      if ($report.shots -and $report.shots.Count -gt 0) {
        foreach ($shot in $report.shots) {
          Write-QaStep ('shot: ' + $shot.file + '  ' + $shot.width + 'x' + $shot.height + '  ' + $shot.bytes + ' bytes')
        }
      } else {
        Write-QaWarn 'no screenshots recorded'
      }
      if ($report.fps) {
        foreach ($fpsProp in $report.fps.PSObject.Properties) {
          $fpsValue = $fpsProp.Value
          if ($fpsValue -and $null -ne $fpsValue.fps) {
            Write-QaStep ('fps[' + $fpsProp.Name + ']: ' + $fpsValue.fps + ' (p95=' + $fpsValue.p95FrameMs + 'ms, longFrames=' + $fpsValue.longFrames + ')')
          }
        }
      }
      if ($report.errors -and $report.errors.Count -gt 0) {
        Write-QaStep ('console errors: ' + $report.errors.Count)
        $report.errors | Select-Object -First 10 | ForEach-Object { Write-QaStep ('  ' + $_) }
      } else {
        Write-QaStep 'console errors: none'
      }
      Write-QaStep ('JSON: ' + $jsonPath)
    } catch {
      Write-QaWarn ('failed to parse ' + $jsonPath + ': ' + $_.Exception.Message)
    }
  } else {
    Write-QaWarn ('no JSON report at ' + $jsonPath)
  }

  if ($appStarted -and -not $KeepApp) {
    Write-QaStep 'stopping Zilux2 (use -KeepApp to keep it running)'
    @(Get-Process -Name 'Zilux2' -ErrorAction SilentlyContinue) | Stop-Process -Force -ErrorAction SilentlyContinue
  } elseif ($KeepApp) {
    Write-QaStep 'leaving Zilux2 running (-KeepApp)'
  }
  Write-QaStep ('exit code: ' + $nodeExit)
}

exit $nodeExit
