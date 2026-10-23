$player = New-Object System.Media.SoundPlayer 'C:\Windows\Media\Alarm01.wav'
$player.PlayLooping()
Start-Sleep -Seconds 25
$player.Stop()
