#Requires -Version 7.0
<#
.SYNOPSIS
    End-to-end self-test for the Zilux2 online music service.

.DESCRIPTION
    Builds the host, launches it against the _devtest page with a fixed token, then runs the
    acceptance checks from docs/zilux2-online-music.md section 7 with curl:
    health, netease/qq search, netease stream (206 + ID3), QQ free/paid stream, lyrics,
    covers, token enforcement, loopback-only binding, per-request log lines, and port release
    after close. Prints PASS/FAIL lines; exits non-zero if anything fails.

    Output is ASCII only: host.log is UTF-8 but the console code page is not guaranteed.
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',

    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectDir = Join-Path $repoRoot 'src\Zilux2'
$webDir = Join-Path $projectDir '_devtest'
$outputDir = Join-Path $projectDir "bin\$Configuration\net10.0-windows10.0.19041.0"
$exePath = Join-Path $outputDir 'Zilux2.exe'
$logPath = Join-Path $env:LOCALAPPDATA 'Zilux2\logs\host.log'
$workDir = Join-Path $PSScriptRoot '_out\online-selftest'
$token = '0123456789abcdef0123456789abcdef'
$wrongToken = 'ffffffffffffffffffffffffffffffff'

$script:passed = 0
$script:failed = 0
$script:failures = New-Object System.Collections.Generic.List[string]
$script:hostProcess = $null
$script:logOffset = 0

function Check {
    param(
        [string]$Name,
        [bool]$Condition,
        [string]$Detail = ''
    )

    if ($Condition) {
        $script:passed++
        Write-Host ("PASS  " + $Name)
    }
    else {
        $script:failed++
        $script:failures.Add($Name)
        $suffix = if ($Detail) { "  (" + $Detail + ")" } else { '' }
        Write-Host ("FAIL  " + $Name + $suffix) -ForegroundColor Red
    }
}

function Read-LogFrom {
    param([long]$Offset)

    if (-not (Test-Path -LiteralPath $logPath)) {
        return ''
    }

    $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($stream.Length -le $Offset) {
            return ''
        }

        $stream.Position = $Offset
        $length = [int]($stream.Length - $Offset)
        $buffer = New-Object byte[] $length
        $read = $stream.Read($buffer, 0, $length)
        return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    }
    finally {
        $stream.Dispose()
    }
}

function Wait-LogMatch {
    param(
        [long]$Offset,
        [string]$Pattern,
        [int]$TimeoutSeconds,
        [string]$Label
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $match = [regex]::Match((Read-LogFrom -Offset $Offset), $Pattern)
        if ($match.Success) {
            return $match
        }
        Start-Sleep -Milliseconds 200
    }

    throw "timed out waiting for log line: $Label"
}

function Wait-WindowHandle {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) {
            return $false
        }
        if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
            return $true
        }
        Start-Sleep -Milliseconds 200
    }

    return $false
}

function Invoke-Curl {
    param(
        [string]$Url,
        [string[]]$RequestHeaders = @(),
        [string]$Name = 'body'
    )

    New-Item -ItemType Directory -Force -Path $workDir | Out-Null
    $bodyFile = Join-Path $workDir ($Name + '.body')
    $headerFile = Join-Path $workDir ($Name + '.headers')
    Remove-Item -LiteralPath $bodyFile, $headerFile -ErrorAction SilentlyContinue

    $curlArgs = @('-s', '-S', '-m', '30', '-o', $bodyFile, '-D', $headerFile, '-w', '%{http_code}')
    foreach ($header in $RequestHeaders) {
        $curlArgs += @('-H', $header)
    }
    $curlArgs += $Url

    $code = & curl.exe @curlArgs
    return [pscustomobject]@{
        Status = [int]$code
        BodyFile = $bodyFile
        HeaderFile = $headerFile
    }
}

function Get-BodyText {
    param($Result)

    if (-not (Test-Path -LiteralPath $Result.BodyFile)) {
        return ''
    }
    return (Get-Content -LiteralPath $Result.BodyFile -Raw -ErrorAction SilentlyContinue)
}

function Get-BodyBytes {
    param($Result)

    if (-not (Test-Path -LiteralPath $Result.BodyFile)) {
        return [byte[]]@()
    }
    return [System.IO.File]::ReadAllBytes($Result.BodyFile)
}

function Get-ResponseHeader {
    param($Result, [string]$Name)

    if (-not (Test-Path -LiteralPath $Result.HeaderFile)) {
        return ''
    }
    $prefix = $Name + ':'
    $line = Get-Content -LiteralPath $Result.HeaderFile |
        Where-Object { $_.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1
    if ($null -eq $line) {
        return ''
    }
    return ($line.Substring($prefix.Length)).Trim()
}

function Test-AudioMagic {
    param([byte[]]$Bytes, [ref]$Detail)

    $id3 = $Bytes.Length -ge 3 -and $Bytes[0] -eq 0x49 -and $Bytes[1] -eq 0x44 -and $Bytes[2] -eq 0x33
    $ftyp = $Bytes.Length -ge 8 -and [System.Text.Encoding]::ASCII.GetString($Bytes, 4, 4) -eq 'ftyp'
    if ($Bytes.Length -ge 8) {
        $Detail.Value = [System.Text.Encoding]::ASCII.GetString($Bytes, 0, 8)
    }
    return $id3 -or $ftyp
}

function Get-ListeningRows {
    param([int]$Port)

    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Stop-HostProcess {
    if ($null -eq $script:hostProcess) {
        return
    }
    try {
        $script:hostProcess.Refresh()
        if (-not $script:hostProcess.HasExited) {
            $script:hostProcess.Kill($true)
            $script:hostProcess.WaitForExit(5000) | Out-Null
        }
    }
    catch {
        # Best effort: the script is already unwinding.
    }
}

try {
    if (-not $SkipBuild) {
        Write-Host 'building host...'
        & (Join-Path $PSScriptRoot 'build.ps1') -Configuration $Configuration
        if ($LASTEXITCODE -ne 0) {
            throw "build failed with exit code $LASTEXITCODE"
        }
    }

    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "host executable not found: $exePath"
    }

    if (-not (Test-Path -LiteralPath $webDir)) {
        throw "devtest web directory not found: $webDir"
    }

    Get-Process -Name 'Zilux2' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300

    if (-not ('OnlineSelftestNative' -as [type])) {
        Add-Type -Namespace OnlineSelftest -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
'@
    }

    $env:ZILUX2_DEV = $null
    $env:ZILUX2_DEV_URL = $null
    $env:ZILUX2_WEB_DIR = $webDir
    $env:ZILUX2_ONLINE_TOKEN = $token

    $script:logOffset = if (Test-Path -LiteralPath $logPath) { (Get-Item -LiteralPath $logPath).Length } else { 0 }
    $script:hostProcess = Start-Process -FilePath $exePath -PassThru

    $windowReady = Wait-WindowHandle -Process $script:hostProcess -TimeoutSeconds 30
    Check 'host window shown' $windowReady
    if (-not $windowReady) {
        throw 'host window never appeared'
    }

    $listening = Wait-LogMatch -Offset $script:logOffset -Pattern '\[online\] listening on 127\.0\.0\.1:(\d+)' -TimeoutSeconds 20 -Label 'online listening'
    $port = [int]$listening.Groups[1].Value
    Write-Host ("online port: " + $port)

    Wait-LogMatch -Offset $script:logOffset -Pattern 'page\.ready' -TimeoutSeconds 20 -Label 'page.ready' | Out-Null
    Wait-LogMatch -Offset $script:logOffset -Pattern '\[online\] endpoint sent to page port=' -TimeoutSeconds 20 -Label 'online endpoint push' | Out-Null

    $sunny = [string][char]0x6674 + [char]0x5929
    $q = [uri]::EscapeDataString($sunny)
    $base = "http://127.0.0.1:$port"

    # --- 1. health ---------------------------------------------------------
    $health = Invoke-Curl -Url "$base/api/health" -Name 'health'
    $healthJson = (Get-BodyText -Result $health) | ConvertFrom-Json
    Check 'health 200' ($health.Status -eq 200) "status $($health.Status)"
    Check 'health ok=true' ($healthJson.ok -eq $true)
    Check 'health sources=netease,qq' ((@($healthJson.sources) -join ',') -eq 'netease,qq') (@($healthJson.sources) -join ',')

    # --- 2. netease search -------------------------------------------------
    $neteaseSearch = Invoke-Curl -Url "$base/api/search?source=netease&q=$q&limit=5&token=$token" -Name 'search-netease'
    $neteaseJson = (Get-BodyText -Result $neteaseSearch) | ConvertFrom-Json
    $neteaseTracks = @($neteaseJson.tracks)
    Check 'netease search 200' ($neteaseSearch.Status -eq 200) "status $($neteaseSearch.Status)"
    Check 'netease search 5 tracks' ($neteaseTracks.Count -eq 5) "tracks $($neteaseTracks.Count)"
    $proxiedCovers = @($neteaseTracks | Where-Object { $_.cover -like "http://127.0.0.1:$port/api/cover*" })
    Check 'netease covers proxied with token' ($proxiedCovers.Count -eq $neteaseTracks.Count) "proxied $($proxiedCovers.Count)/$($neteaseTracks.Count)"
    $neteaseTrack = $neteaseTracks | Where-Object { $_.playable } | Select-Object -First 1
    if ($null -eq $neteaseTrack) {
        $neteaseTrack = $neteaseTracks[0]
    }
    Check 'netease track has title' (-not [string]::IsNullOrWhiteSpace($neteaseTrack.title))

    # --- 3. QQ search (primary client_search_cp, fallback search_for_qq_cp) -
    $qqSearch = Invoke-Curl -Url "$base/api/search?source=qq&q=$q&limit=5&token=$token" -Name 'search-qq'
    $qqStatusText = "status $($qqSearch.Status)"
    if ($qqSearch.Status -ne 200) {
        $failLog = Read-LogFrom -Offset $script:logOffset
        $failLines = @($failLog -split "`n" | Where-Object { $_ -match 'qq/search|qq search' } | Select-Object -Last 4)
        $qqStatusText += " | " + ($failLines -join ' | ')
    }
    Check 'qq search 200 (primary or fallback)' ($qqSearch.Status -eq 200) $qqStatusText
    $qqJson = (Get-BodyText -Result $qqSearch) | ConvertFrom-Json
    $qqTracks = @($qqJson.tracks)
    Check 'qq search tracks' ($qqTracks.Count -gt 0) "tracks $($qqTracks.Count)"
    if ($qqTracks.Count -gt 0) {
        $qqFirst = $qqTracks[0]
        $qqFields = @('id', 'title', 'artist', 'album', 'durationMs', 'playable')
        $missingFields = @($qqFields | Where-Object { $null -eq $qqFirst.PSObject.Properties[$_] })
        Check 'qq track model fields complete' ($missingFields.Count -eq 0) ("missing: " + ($missingFields -join ','))
        Check 'qq track has id' (-not [string]::IsNullOrWhiteSpace([string]$qqFirst.id)) ([string]$qqFirst.id)
        Check 'qq track has title' (-not [string]::IsNullOrWhiteSpace([string]$qqFirst.title)) ([string]$qqFirst.title)
        Check 'qq track has artist' (-not [string]::IsNullOrWhiteSpace([string]$qqFirst.artist)) ([string]$qqFirst.artist)
        Check 'qq track has album' (-not [string]::IsNullOrWhiteSpace([string]$qqFirst.album)) ([string]$qqFirst.album)
        Check 'qq track durationMs > 0' ([double]$qqFirst.durationMs -gt 0) ([string]$qqFirst.durationMs)
        Check 'qq track exposes playable' ($null -ne $qqFirst.playable) ([string]$qqFirst.playable)
    }

    # --- 4. netease stream (Range 0-2047 => 206 + ID3) ---------------------
    $neteaseStream = Invoke-Curl -Url "$base/api/stream?source=netease&id=$($neteaseTrack.id)&token=$token" -RequestHeaders @('Range: bytes=0-2047') -Name 'stream-netease'
    $neteaseBytes = Get-BodyBytes -Result $neteaseStream
    $audioDetail = ''
    $audioOk = Test-AudioMagic -Bytes $neteaseBytes -Detail ([ref]$audioDetail)
    $neteaseRange = Get-ResponseHeader -Result $neteaseStream -Name 'Content-Range'
    $neteaseType = Get-ResponseHeader -Result $neteaseStream -Name 'Content-Type'
    Check 'netease stream 206' ($neteaseStream.Status -eq 206) "status $($neteaseStream.Status)"
    Check 'netease stream Content-Range' ($neteaseRange -match '^bytes 0-2047/\d+$') $neteaseRange
    Check 'netease stream 2048 bytes' ($neteaseBytes.Length -eq 2048) "bytes $($neteaseBytes.Length)"
    Check 'netease stream audio magic' $audioOk $audioDetail
    Check 'netease stream Content-Type' ($neteaseType -match 'audio/') $neteaseType

    # --- 5. QQ free stream / paid track gets 403 ---------------------------
    $qqFree = Invoke-Curl -Url "$base/api/stream?source=qq&id=0042rlGx2WHBrG&token=$token" -RequestHeaders @('Range: bytes=0-2047') -Name 'stream-qq-free'
    $qqFreeBytes = Get-BodyBytes -Result $qqFree
    $qqDetail = ''
    $qqFreeOk = Test-AudioMagic -Bytes $qqFreeBytes -Detail ([ref]$qqDetail)
    $qqRange = Get-ResponseHeader -Result $qqFree -Name 'Content-Range'
    $qqType = Get-ResponseHeader -Result $qqFree -Name 'Content-Type'
    Check 'qq free stream 206' ($qqFree.Status -eq 206) "status $($qqFree.Status)"
    Check 'qq free stream Content-Range' ($qqRange -match '^bytes 0-2047/\d+$') $qqRange
    Check 'qq free stream audio magic' $qqFreeOk $qqDetail
    Check 'qq free stream Content-Type' ($qqType -match 'audio/') $qqType

    $qqPaid = Invoke-Curl -Url "$base/api/stream?source=qq&id=0039MnYb0qxYhV&token=$token" -Name 'stream-qq-paid'
    $qqPaidJson = (Get-BodyText -Result $qqPaid) | ConvertFrom-Json
    Check 'qq paid stream 403' ($qqPaid.Status -eq 403) "status $($qqPaid.Status)"
    Check 'qq paid stream not-playable' ($qqPaidJson.error -eq 'not-playable') ([string]$qqPaidJson.error)

    # --- 6. lyrics ---------------------------------------------------------
    $neteaseLyric = Invoke-Curl -Url "$base/api/lyric?source=netease&id=3391116218&token=$token" -Name 'lyric-netease'
    $neteaseLyricJson = (Get-BodyText -Result $neteaseLyric) | ConvertFrom-Json
    Check 'netease lyric 200' ($neteaseLyric.Status -eq 200) "status $($neteaseLyric.Status)"
    Check 'netease lyric has [00:' ($neteaseLyricJson.lrc -match '\[00:') "lrcChars $(([string]$neteaseLyricJson.lrc).Length)"

    $qqLyric = Invoke-Curl -Url "$base/api/lyric?source=qq&id=0039MnYb0qxYhV&token=$token" -Name 'lyric-qq'
    $qqLyricJson = (Get-BodyText -Result $qqLyric) | ConvertFrom-Json
    Check 'qq lyric 200' ($qqLyric.Status -eq 200) "status $($qqLyric.Status)"
    Check 'qq lyric has [00:' ($qqLyricJson.lrc -match '\[00:') "lrcChars $(([string]$qqLyricJson.lrc).Length)"

    # --- 7. covers ---------------------------------------------------------
    $qqCover = Invoke-Curl -Url "$base/api/cover?source=qq&key=000MkMni19ClKG&token=$token" -Name 'cover-qq'
    $qqCoverBytes = Get-BodyBytes -Result $qqCover
    $qqCoverType = Get-ResponseHeader -Result $qqCover -Name 'Content-Type'
    Check 'qq cover 200' ($qqCover.Status -eq 200) "status $($qqCover.Status)"
    Check 'qq cover image/*' ($qqCoverType -match '^image/') $qqCoverType
    Check 'qq cover bytes' ($qqCoverBytes.Length -gt 1000) "bytes $($qqCoverBytes.Length)"

    $neteaseCover = Invoke-Curl -Url $neteaseTrack.cover -Name 'cover-netease'
    $neteaseCoverBytes = Get-BodyBytes -Result $neteaseCover
    $neteaseCoverType = Get-ResponseHeader -Result $neteaseCover -Name 'Content-Type'
    Check 'netease cover 200' ($neteaseCover.Status -eq 200) "status $($neteaseCover.Status)"
    Check 'netease cover image/*' ($neteaseCoverType -match '^image/') $neteaseCoverType
    Check 'netease cover bytes' ($neteaseCoverBytes.Length -gt 1000) "bytes $($neteaseCoverBytes.Length)"

    # --- 8. token enforcement + loopback-only binding ----------------------
    $noToken = Invoke-Curl -Url "$base/api/search?source=netease&q=$q" -Name 'search-no-token'
    $noTokenJson = (Get-BodyText -Result $noToken) | ConvertFrom-Json
    Check 'search without token 401' ($noToken.Status -eq 401) "status $($noToken.Status)"
    Check 'search without token error=unauthorized' ($noTokenJson.error -eq 'unauthorized') ([string]$noTokenJson.error)

    $badToken = Invoke-Curl -Url "$base/api/search?source=netease&q=$q&token=$wrongToken" -Name 'search-bad-token'
    Check 'search with wrong token 401' ($badToken.Status -eq 401) "status $($badToken.Status)"

    $listening = Get-ListeningRows -Port $port
    Check 'listener rows exist' ($listening.Count -gt 0) "rows $($listening.Count)"
    $nonLoopback = @($listening | Where-Object { $_.LocalAddress -ne '127.0.0.1' })
    Check 'listener bound to 127.0.0.1 only' ($nonLoopback.Count -eq 0) (($nonLoopback | ForEach-Object { $_.LocalAddress }) -join ',')
    $wildcard = @(& netstat.exe -ano | Select-String -Pattern ("0\.0\.0\.0:" + $port + "|\[::\]:" + $port))
    Check 'netstat shows no wildcard bind' ($wildcard.Count -eq 0) (($wildcard | ForEach-Object { $_.Line.Trim() }) -join '; ')

    # --- 9. logging: one line per request, token never logged --------------
    $logText = Read-LogFrom -Offset $script:logOffset
    Check 'log: listening line' ($logText -match '\[online\] listening on 127\.0\.0\.1:\d+')
    Check 'log: netease search line' ($logText -match '\[online\] GET netease/search q=\S+ ok \d+ tracks \d+ms')
    $qqPrimaryLog = $logText -match '\[online\] GET qq/search q=\S+ ok \d+ tracks \d+ms'
    $qqFallbackLog = $logText -match '\[online\] qq search fallback=search_for_qq_cp ok n=\d+ \d+ms'
    Check 'log: qq search line (primary or fallback)' ($qqPrimaryLog -or $qqFallbackLog) "primary=$qqPrimaryLog fallback=$qqFallbackLog"
    if ($qqFallbackLog) {
        Write-Host 'qq search path: fallback=search_for_qq_cp'
    }
    elseif ($qqPrimaryLog) {
        Write-Host 'qq search path: primary=client_search_cp'
    }
    Check 'log: vkey line' ($logText -match '\[online\] POST qq/vkey id=\S+ (ok|not-playable)')
    Check 'log: local request line' ($logText -match '\[online\] req GET /api/search status=200')
    Check 'log: page online event' ($logText -match 'web:info devtest online event port=\d+ sources=netease,qq')
    Check 'log: page health ok' ($logText -match 'web:info devtest health status=200 ok=true')
    Check 'log: page search cover proxy' ($logText -match 'web:info devtest search status=200 tracks=2 coverProxy=yes')
    Check 'log: token not logged' (-not $logText.Contains($token))

    # --- 10. close + port release -----------------------------------------
    [OnlineSelftest.Native]::PostMessage($script:hostProcess.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $exited = $script:hostProcess.WaitForExit(10000)
    Check 'host exited after close' $exited
    if ($exited) {
        Check 'host exit code 0' ($script:hostProcess.ExitCode -eq 0) "exit $($script:hostProcess.ExitCode)"
    }
    Start-Sleep -Milliseconds 500
    Check 'port released after close' ((Get-ListeningRows -Port $port).Count -eq 0)
    Check 'no Zilux2 process left' ((Get-Process -Name 'Zilux2' -ErrorAction SilentlyContinue) -eq $null)
}
catch {
    Write-Host ("ERROR  " + $_.Exception.Message) -ForegroundColor Red
    $script:failed++
    $script:failures.Add($_.Exception.Message)
}
finally {
    Stop-HostProcess
}

Write-Host ''
Write-Host ("SUMMARY  passed=" + $script:passed + "  failed=" + $script:failed)
if ($script:failed -gt 0) {
    Write-Host ("failed checks: " + ($script:failures -join ' | ')) -ForegroundColor Red
    exit 1
}

Write-Host 'online music service: all checks passed.'
exit 0
