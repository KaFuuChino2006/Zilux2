using System.Text;
using Zilux2.Audio;
using Zilux2.AirPlay.Audio;
using Zilux2.AirPlay.Protocol;

Console.OutputEncoding = Encoding.UTF8;

if (args.Length < 2)
{
    Console.WriteLine("usage: harness <handshake|stream> <host> [seconds] [alac|l16] [name]");
    return 2;
}

var mode = args[0];
var host = args[1];
var seconds = args.Length > 2 && double.TryParse(args[2], out var parsedSeconds) ? parsedSeconds : 3.0;
var codec = args.Length > 3 ? args[3] : "alac";
var name = args.Length > 4 ? args[4] : "Zilux2 Test";
var useL16 = codec.Equals("l16", StringComparison.OrdinalIgnoreCase);

Console.WriteLine($"[harness] mode={mode} target={name} {host}:7000 codec={codec} seconds={seconds}");

if (mode == "trace")
{
    TraceHandshake(host, useL16);
    return 0;
}

static void TraceHandshake(string host, bool useL16)
{
    var userAgent = Environment.GetEnvironmentVariable("ZILUX2_UA")
        ?? "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)";
    string localIp;
    using (var probe = new System.Net.Sockets.UdpClient())
    {
        probe.Connect(host, 7000);
        localIp = ((System.Net.IPEndPoint)probe.Client.LocalEndPoint!).Address.ToString();
    }

    Console.WriteLine($"[trace] local={localIp} ua={userAgent}");
    using var transport = RtspTransport.Connect(host, 7000, TimeSpan.FromSeconds(6));
    var common = new List<KeyValuePair<string, string>>
    {
        new("CSeq", "1"),
        new("User-Agent", userAgent),
        new("Client-Instance", "0123456789abcdef"),
        new("DACP-ID", "0123456789abcdef"),
        new("Active-Remote", "12345678"),
    };

    var options = transport.Send("OPTIONS", "*", common);
    Console.WriteLine("[trace] OPTIONS -> " + options.Describe());
    foreach (var header in options.Headers)
    {
        Console.WriteLine($"[trace]   {header.Key}: {header.Value}");
    }

    if (!options.IsSuccess)
    {
        return;
    }

    var resource = Random.Shared.Next(1_000_000_000, int.MaxValue).ToString();
    var uri = $"rtsp://{localIp}/{resource}";
    var sdp = new StringBuilder();
    sdp.Append("v=0\r\n");
    sdp.Append("o=iTunes ").Append(resource).Append(" 0 IN IP4 ").Append(localIp).Append("\r\n");
    sdp.Append("s=iTunes\r\n");
    sdp.Append("c=IN IP4 ").Append(localIp).Append("\r\n");
    sdp.Append("t=0 0\r\n");
    sdp.Append("m=audio 0 RTP/AVP 96\r\n");
    sdp.Append("a=rtpmap:96 ").Append(useL16 ? "L16/44100/2" : "AppleLossless").Append("\r\n");
    sdp.Append("a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\n");
    var announceHeaders = new List<KeyValuePair<string, string>>(common)
    {
        new("CSeq", "2"),
        new("Content-Type", "application/sdp"),
    };
    var announce = transport.Send("ANNOUNCE", uri, announceHeaders, Encoding.UTF8.GetBytes(sdp.ToString()));
    Console.WriteLine("[trace] ANNOUNCE -> " + announce.Describe());
    foreach (var header in announce.Headers)
    {
        Console.WriteLine($"[trace]   {header.Key}: {header.Value}");
    }

    if (!announce.IsSuccess)
    {
        return;
    }

    using var control = new System.Net.Sockets.UdpClient(0);
    using var timing = new System.Net.Sockets.UdpClient(0);
    var controlPort = ((System.Net.IPEndPoint)control.Client.LocalEndPoint!).Port;
    var timingPort = ((System.Net.IPEndPoint)timing.Client.LocalEndPoint!).Port;
    var setupHeaders = new List<KeyValuePair<string, string>>(common)
    {
        new("CSeq", "3"),
        new("Transport", $"RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port={controlPort};timing_port={timingPort}"),
    };
    var setup = transport.Send("SETUP", uri, setupHeaders);
    Console.WriteLine("[trace] SETUP -> " + setup.Describe());
    foreach (var header in setup.Headers)
    {
        Console.WriteLine($"[trace]   {header.Key}: {header.Value}");
    }

    if (!setup.IsSuccess)
    {
        return;
    }

    var session = setup.Header("Session")?.Split(';')[0] ?? "1";
    var recordHeaders = new List<KeyValuePair<string, string>>(common)
    {
        new("CSeq", "4"),
        new("Session", session),
        new("Range", "npt=0-"),
        new("RTP-Info", "seq=0;rtptime=0"),
    };
    var record = transport.Send("RECORD", uri, recordHeaders);
    Console.WriteLine("[trace] RECORD -> " + record.Describe());
    foreach (var header in record.Headers)
    {
        Console.WriteLine($"[trace]   {header.Key}: {header.Value}");
    }

    var volumeHeaders = new List<KeyValuePair<string, string>>(common)
    {
        new("CSeq", "5"),
        new("Session", session),
        new("Content-Type", "text/parameters"),
    };
    var volume = transport.Send("SET_PARAMETER", uri, volumeHeaders, Encoding.UTF8.GetBytes("volume: -12.000000\r\n"));
    Console.WriteLine("[trace] SET_PARAMETER -> " + volume.Describe());

    var teardownHeaders = new List<KeyValuePair<string, string>>(common)
    {
        new("CSeq", "6"),
        new("Session", session),
    };
    var teardown = transport.Send("TEARDOWN", uri, teardownHeaders);
    Console.WriteLine("[trace] TEARDOWN -> " + teardown.Describe());
}


if (mode is "pin" or "pairpin")
{
    try
    {
        using var transport = RtspTransport.Connect(host, 7000, TimeSpan.FromSeconds(5));
        var headers = new[]
        {
            new KeyValuePair<string, string>("CSeq", "1"),
            new KeyValuePair<string, string>("User-Agent", "Zilux2/0.1"),
            new KeyValuePair<string, string>("Client-Instance", "0123456789abcdef"),
            new KeyValuePair<string, string>("DACP-ID", "0123456789abcdef"),
            new KeyValuePair<string, string>("Active-Remote", "12345678"),
        };
        var start = transport.Send("POST", "/pair-pin-start", headers);
        Console.WriteLine("[pin] POST /pair-pin-start -> " + start.Describe());
        foreach (var header in start.Headers)
        {
            Console.WriteLine($"[pin]   {header.Key}: {header.Value}");
        }

        var options = transport.Send("OPTIONS", "*", headers);
        Console.WriteLine("[pin] OPTIONS after pair-pin-start -> " + options.Describe());
    }
    catch (Exception exception)
    {
        Console.WriteLine($"[pin] FAILED: {exception.GetType().Name}: {exception.Message}");
    }

    return 0;
}

if (mode is "rawopt" or "raw")
{
    try
    {
        using var transport = RtspTransport.Connect(host, 7000, TimeSpan.FromSeconds(5));
        var headers = new[]
        {
            new KeyValuePair<string, string>("CSeq", "1"),
            new KeyValuePair<string, string>("User-Agent", "Zilux2/0.1"),
            new KeyValuePair<string, string>("Client-Instance", "0123456789abcdef"),
            new KeyValuePair<string, string>("DACP-ID", "0123456789abcdef"),
            new KeyValuePair<string, string>("Active-Remote", "12345678"),
            new KeyValuePair<string, string>("Content-Length", "0"),
        };
        var reply = transport.Send("OPTIONS", "*", headers);
        Console.WriteLine("[raw] " + reply.Describe());
        foreach (var header in reply.Headers)
        {
            Console.WriteLine($"[raw]   {header.Key}: {header.Value}");
        }

        if (reply.Body.Length > 0)
        {
            Console.WriteLine("[raw] body: " + Encoding.UTF8.GetString(reply.Body));
        }

        if (mode == "raw")
        {
            var info = transport.Send("GET", "/info", headers);
            Console.WriteLine("[raw] GET /info -> " + info.Describe());
            foreach (var header in info.Headers)
            {
                Console.WriteLine($"[raw]   {header.Key}: {header.Value}");
            }

            var path = Path.Combine(AppContext.BaseDirectory, $"info-{host}.bin");
            File.WriteAllBytes(path, info.Body);
            Console.WriteLine($"[raw] info body {info.Body.Length}B saved to {path}");
        }
    }
    catch (Exception exception)
    {
        Console.WriteLine($"[raw] FAILED: {exception.GetType().Name}: {exception.Message}");
    }

    return 0;
}

if (mode == "captest")
{
    // Reproduce the product setup: AudioFeatureService keeps one loopback client
    // alive while AirPlayStreamer opens a second one on the same endpoint.
    var seconds2 = seconds <= 0 ? 6.0 : seconds;
    var primary = new LoopbackCapture();
    var secondary = new LoopbackCapture();
    Console.WriteLine($"[captest] primary start={primary.TryStart()} rate={primary.SampleRate} ch={primary.Channels} err={primary.LastError}");
    Console.WriteLine($"[captest] secondary start={secondary.TryStart()} rate={secondary.SampleRate} ch={secondary.Channels} err={secondary.LastError}");
    using var cts = new CancellationTokenSource();
    var primaryRms = new double[1];
    var drain = new Thread(() =>
    {
        var buffer = new float[16384];
        while (!cts.IsCancellationRequested)
        {
            if (!primary.WaitForData(20))
            {
                continue;
            }

            var read = primary.Read(buffer);
            if (read <= 0)
            {
                continue;
            }

            double sum = 0;
            for (var i = 0; i < read; i++)
            {
                sum += buffer[i] * buffer[i];
            }

            primaryRms[0] = Math.Sqrt(sum / read);
        }
    })
    {
        IsBackground = true,
    };
    drain.Start();

    var interleaved = new float[16384 * 2];
    var deadline2 = DateTime.UtcNow.AddSeconds(seconds2);
    while (DateTime.UtcNow < deadline2)
    {
        if (!secondary.WaitForData(20))
        {
            Console.WriteLine("[captest] secondary timeout");
            Thread.Sleep(50);
            continue;
        }

        var frames = secondary.ReadInterleaved(interleaved);
        double sum = 0;
        for (var i = 0; i < frames * 2; i++)
        {
            sum += interleaved[i] * interleaved[i];
        }

        Console.WriteLine($"[captest] secondary rms={Math.Sqrt(sum / Math.Max(1, frames * 2)):F4} primary rms={primaryRms[0]:F4}");
        Thread.Sleep(150);
    }

    cts.Cancel();
    primary.Dispose();
    secondary.Dispose();
    return 0;
}

if (mode == "ap2frame")
{
    // Byte-level sanity check for the uncompressed-ALAC ("escape") frames the AP2
    // realtime stream needs: 1408 sample bytes + 25 header/trailer bits -> 1412 bytes.
    var encoder = new Ap2UncompressedAlacEncoder();
    var pcm = new short[encoder.FrameSamples * 2];
    for (var i = 0; i < pcm.Length; i++)
    {
        pcm[i] = (short)(i * 37 - 13000);
    }

    var buffer = new byte[encoder.MaxPacketBytes];
    var written = encoder.Encode(pcm, buffer);
    Console.WriteLine($"[harness] ap2frame bytes={written} head={Convert.ToHexString(buffer.AsSpan(0, 8))} tail={Convert.ToHexString(buffer.AsSpan(written - 4, 4))}");
    return written > 0 ? 0 : 1;
}

if (mode == "ap2")
{
    // ZILUX2_AP2_CODEC=pcm (default) or alac selects both the negotiated stream format
    // (ct/audioFormat) and the payload encoder, so a receiver that ignores ct can be probed.
    var ap2Codec = (Environment.GetEnvironmentVariable("ZILUX2_AP2_CODEC") ?? "pcm").Trim().ToLowerInvariant();
    var useAlac = ap2Codec == "alac";
    var ap2LatencyMs = int.TryParse(Environment.GetEnvironmentVariable("ZILUX2_AP2_LATENCY_MS"), out var parsedLatency)
        ? parsedLatency
        : 120;
    Console.WriteLine($"[harness] ap2 codec={ap2Codec} (negotiated alac={useAlac}) latency={ap2LatencyMs}ms");

    // macOS "AirPlay Receiver" rejects transient pairing and shows a 4-digit PIN: either pass it
    // directly or let the operator drop it into a file while the pairing prompt is on screen.
    Func<CancellationToken, Task<string>>? pinProvider = null;
    var pinFile = Environment.GetEnvironmentVariable("ZILUX2_AP2_PIN_FILE");
    var pinDirect = Environment.GetEnvironmentVariable("ZILUX2_AP2_PIN");
    if (!string.IsNullOrEmpty(pinFile))
    {
        pinProvider = async cancellationToken =>
        {
            for (var attempt = 0; attempt < 240; attempt++)
            {
                if (File.Exists(pinFile))
                {
                    var value = (await File.ReadAllTextAsync(pinFile, cancellationToken)).Trim();
                    if (value.Length >= 4)
                    {
                        File.Delete(pinFile);
                        Console.WriteLine($"[harness] pin={value}");
                        return value;
                    }
                }

                await Task.Delay(500, cancellationToken);
            }

            throw new TimeoutException("no pin file appeared");
        };
    }
    else if (!string.IsNullOrEmpty(pinDirect))
    {
        pinProvider = _ => Task.FromResult(pinDirect);
    }

    IAirPlayConnection ap2;
    try
    {
        ap2 = Ap2AudioConnection.Create(
            new RaopTarget { Name = name, Host = host, Port = 7000 },
            new RaopOptions
            {
                UserAgent = Environment.GetEnvironmentVariable("ZILUX2_UA")
                    ?? "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)",
            },
            useAlac: useAlac,
            latencyMilliseconds: ap2LatencyMs,
            pinProvider: pinProvider);
        Console.WriteLine("[harness] ap2 pairing + encrypted handshake ok");
    }
    catch (Exception exception)
    {
        Console.WriteLine($"[harness] AP2 CONNECT FAILED: {exception.GetType().Name}: {exception.Message}");
        return 1;
    }

    try
    {
        IAirPlayAudioEncoder encoder = useAlac
            ? new Ap2UncompressedAlacEncoder()
            : new PcmLittleEndianEncoder();
        using var streamer = new AirPlayStreamer(encoder);
        streamer.VolumePercent = 60;
        streamer.Start(ap2);
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(1000);
            Console.WriteLine(
                $"[harness] frames={streamer.FramesSent} capture={streamer.CaptureReads} " +
                $"timeouts={streamer.CaptureTimeouts} encodeFailures={streamer.EncodeFailures}");
        }

        streamer.Stop();
        Console.WriteLine("[harness] ap2 stream stopped");
        return 0;
    }
    catch (Exception exception)
    {
        Console.WriteLine($"[harness] AP2 STREAM FAILED: {exception.GetType().Name}: {exception.Message}");
        return 1;
    }
}

if (mode == "ap2multi")
{
    // Two receivers on one capture/encode/timeline: ap2multi <host1> <host2> [seconds].
    var latencyMs = int.TryParse(Environment.GetEnvironmentVariable("ZILUX2_AP2_LATENCY_MS"), out var multiLatency)
        ? multiLatency
        : 300;
    var targets = new List<AirPlayConnectionTarget>();
    var connections = new List<IAirPlayConnection>();
    foreach (var (multiHost, index) in new[] { host, args.Length > 3 ? args[3] : host }.Select((value, i) => (value, i)))
    {
        if (string.IsNullOrWhiteSpace(multiHost))
        {
            continue;
        }

        try
        {
            var ap2Connection = Ap2AudioConnection.Create(
                new RaopTarget { Name = $"receiver-{index + 1}", Host = multiHost, Port = 7000 },
                new RaopOptions
                {
                    UserAgent = Environment.GetEnvironmentVariable("ZILUX2_UA")
                        ?? "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)",
                },
                useAlac: true,
                latencyMilliseconds: latencyMs);
            connections.Add(ap2Connection);
            targets.Add(new AirPlayConnectionTarget(multiHost, ap2Connection));
            Console.WriteLine($"[harness] ap2multi connected receiver-{index + 1} {multiHost}");
        }
        catch (Exception exception)
        {
            Console.WriteLine($"[harness] ap2multi receiver-{index + 1} {multiHost} FAILED: {exception.GetType().Name}: {exception.Message}");
        }
    }

    if (targets.Count == 0)
    {
        Console.WriteLine("[harness] ap2multi: no receiver connected");
        return 1;
    }

    try
    {
        using var streamer = new AirPlayStreamer(new Ap2UncompressedAlacEncoder());
        streamer.ConnectionLost += (deviceId, exception) =>
            Console.WriteLine($"[harness] ap2multi lost {deviceId}: {exception.GetType().Name}: {exception.Message}");
        streamer.VolumePercent = 60;
        streamer.Start(targets);
        Console.WriteLine($"[harness] ap2multi streaming to {streamer.ConnectionCount} receiver(s)");

        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(1000);
            Console.WriteLine(
                $"[harness] ap2multi frames={streamer.FramesSent} receivers={streamer.ConnectionCount} " +
                $"capture={streamer.CaptureReads} underruns={streamer.Underruns} encodeFailures={streamer.EncodeFailures}");
        }

        streamer.Stop();
        Console.WriteLine("[harness] ap2multi stream stopped");
        return 0;
    }
    catch (Exception exception)
    {
        Console.WriteLine($"[harness] ap2multi STREAM FAILED: {exception.GetType().Name}: {exception.Message}");
        return 1;
    }
    finally
    {
        foreach (var openConnection in connections)
        {
            try
            {
                openConnection.Dispose();
            }
            catch
            {
                // ignored: harness teardown
            }
        }
    }
}

RaopConnection connection;
try
{
    connection = RaopConnection.Connect(
        new RaopTarget { Name = name, Host = host, Port = 7000 },
        new RaopOptions { BufferLatencyMilliseconds = 2000, UseLinearPcm = useL16, UserAgent = Environment.GetEnvironmentVariable("ZILUX2_UA") ?? "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)" });
}
catch (Exception exception)
{
    Console.WriteLine($"[harness] CONNECT FAILED: {exception.GetType().Name}: {exception.Message}");
    return 1;
}

Console.WriteLine("[harness] handshake ok (OPTIONS/ANNOUNCE/SETUP)");
try
{
    connection.BeginStreaming();
    Console.WriteLine("[harness] RECORD ok, sync timer started");
    connection.SetVolume(50);
    Console.WriteLine("[harness] volume 50 sent");

    if (mode != "stream")
    {
        Thread.Sleep((int)(seconds * 1000));
    }
    else
    {
        StreamAudio(connection, seconds, useL16);
    }

    connection.Teardown();
    Console.WriteLine("[harness] teardown ok");
}
catch (Exception exception)
{
    Console.WriteLine($"[harness] FAILED: {exception.GetType().Name}: {exception.Message}");
    return 1;
}
finally
{
    connection.Dispose();
}

Console.WriteLine("[harness] done");
return 0;

static void StreamAudio(RaopConnection connection, double seconds, bool useL16)
{
    using var capture = new LoopbackCapture();
    var captureStarted = capture.TryStart();
    if (!captureStarted)
    {
        Console.WriteLine($"[harness] capture unavailable: {capture.LastError}");
        Console.WriteLine("[harness] switching to silence generator");
    }

    var sourceRate = captureStarted ? capture.SampleRate : RaopConnection.SampleRate;
    var resampler = new StereoResampler(sourceRate, RaopConnection.SampleRate);
    var encoder = useL16 ? null : new AlacAudioEncoder();
    var chunkFrames = Math.Max(256, sourceRate / 50);
    var captureBuffer = new float[(chunkFrames + 128) * 2];
    var outputBuffer = new float[(int)((chunkFrames + 128) * (RaopConnection.SampleRate / (double)sourceRate) * 2) + 512];
    var pcmFrame = new short[RaopConnection.SamplesPerFrame * 2];
    var payload = new byte[RaopConnection.BytesPerFrame + 64];
    var pcmFill = 0;
    var frames = 0;
    var timeouts = 0;
    var deadline = DateTime.UtcNow.AddSeconds(seconds);

    while (DateTime.UtcNow < deadline)
    {
        var inputFrames = 0;
        if (captureStarted && capture.WaitForData(20))
        {
            inputFrames = capture.ReadInterleaved(captureBuffer);
        }
        else
        {
            timeouts++;
            Array.Clear(captureBuffer, 0, chunkFrames * 2);
            inputFrames = chunkFrames;
        }

        var produced = resampler.Process(captureBuffer, inputFrames, outputBuffer);
        for (var frame = 0; frame < produced; frame++)
        {
            pcmFrame[pcmFill++] = ToPcm(outputBuffer[frame * 2]);
            pcmFrame[pcmFill++] = ToPcm(outputBuffer[frame * 2 + 1]);
            if (pcmFill < pcmFrame.Length)
            {
                continue;
            }

            var encoded = useL16 ? WriteBigEndian(pcmFrame, payload) : encoder!.Encode(pcmFrame, payload);
            if (encoded > 0)
            {
                connection.SendAudioFrame(new ReadOnlySpan<byte>(payload, 0, encoded));
                frames++;
            }

            pcmFill = 0;
        }
    }

    var played = frames * RaopConnection.SamplesPerFrame / (double)RaopConnection.SampleRate;
    Console.WriteLine($"[harness] sent {frames} packets ({played:F1}s audio), captureTimeouts={timeouts}");
}

static short ToPcm(float value) => (short)Math.Clamp((int)MathF.Round(value * 32767f), short.MinValue, short.MaxValue);

static int WriteBigEndian(short[] pcm, byte[] destination)
{
    for (var index = 0; index < pcm.Length; index++)
    {
        destination[index * 2] = (byte)(pcm[index] >> 8);
        destination[index * 2 + 1] = (byte)pcm[index];
    }

    return pcm.Length * 2;
}
