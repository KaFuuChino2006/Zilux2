param([string]$HostIp = "192.168.31.233", [int]$Port = 7000)

$ErrorActionPreference = "Stop"

$m1 = [byte[]](0x00,0x01,0x00, 0x06,0x01,0x01, 0x13,0x01,0x10)

function Send-Raw([byte[]]$payload, [string]$label) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect($HostIp, $Port)
        $client.ReceiveTimeout = 5000
        $stream = $client.GetStream()
        $stream.Write($payload, 0, $payload.Length)
        $stream.Flush()
        Start-Sleep -Milliseconds 700
        $buffer = New-Object byte[] 4096
        $read = 0
        try { $read = $stream.Read($buffer, 0, $buffer.Length) } catch { }
        $text = [System.Text.Encoding]::ASCII.GetString($buffer, 0, [Math]::Max($read, 0))
        $first = ($text -split "`r`n")[0]
        Write-Output ("{0} -> {1} ({2} bytes)" -f $label, $first, $read)
    } catch {
        Write-Output ("{0} -> EXC {1}" -f $label, $_.Exception.Message)
    } finally {
        $client.Close()
    }
}

function Ascii([string]$s) { [System.Text.Encoding]::ASCII.GetBytes($s) }

$hdrA = Ascii "POST /pair-pin-start RTSP/1.0`r`nCSeq: 1`r`nUser-Agent: AirPlay/550.10`r`nContent-Length: 0`r`n`r`n"
Send-Raw $hdrA "pin-start RTSP"

$hdrB = Ascii "POST /pair-pin-start HTTP/1.1`r`nHost: ${HostIp}:7000`r`nUser-Agent: AirPlay/550.10`r`nX-Apple-HKP: 3`r`nContent-Type: application/octet-stream`r`nContent-Length: 0`r`nConnection: keep-alive`r`n`r`n"
Send-Raw $hdrB "pin-start HTTP keep-alive"

$bodyA = Ascii "POST /pair-setup RTSP/1.0`r`nCSeq: 1`r`nUser-Agent: AirPlay/550.10`r`nContent-Type: application/octet-stream`r`nContent-Length: $($m1.Length)`r`n`r`n"
$reqC = New-Object byte[] ($bodyA.Length + $m1.Length)
[Array]::Copy($bodyA, 0, $reqC, 0, $bodyA.Length)
[Array]::Copy($m1, 0, $reqC, $bodyA.Length, $m1.Length)
Send-Raw $reqC "pair-setup RTSP transient M1"

$hdrD = Ascii "OPTIONS * RTSP/1.0`r`nCSeq: 1`r`nUser-Agent: AirPlay/550.10`r`nContent-Length: 0`r`n`r`n"
Send-Raw $hdrD "OPTIONS RTSP AirPlay UA"

$hdrE = Ascii "POST /pair-setup HTTP/1.1`r`nHost: ${HostIp}:7000`r`nUser-Agent: AirPlay/550.10`r`nX-Apple-HKP: 3`r`nContent-Type: application/octet-stream`r`nContent-Length: $($m1.Length)`r`nConnection: keep-alive`r`n`r`n"
$reqE = New-Object byte[] ($hdrE.Length + $m1.Length)
[Array]::Copy($hdrE, 0, $reqE, 0, $hdrE.Length)
[Array]::Copy($m1, 0, $reqE, $hdrE.Length, $m1.Length)
Send-Raw $reqE "pair-setup HTTP keep-alive transient M1"
