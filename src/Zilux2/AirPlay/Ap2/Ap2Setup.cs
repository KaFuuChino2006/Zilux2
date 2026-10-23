using System.IO;

namespace Zilux2.AirPlay.Ap2;

/// <summary>Options for one AP2 audio stream, mapped onto the <c>SETUP</c> binary plist.</summary>
internal sealed class Ap2SetupOptions
{
    /// <summary>96 = realtime audio, 103 = buffered audio.</summary>
    public int StreamType { get; init; } = Ap2Setup.RealtimeAudioStreamType;

    /// <summary>1 = PCM (L16), 2 = ALAC. HomePod accepts both; ALAC matches the existing encoder.</summary>
    public int CompressionType { get; init; } = Ap2Setup.AlacCompressionType;

    public int FramesPerPacket { get; init; } = 352;

    public int SampleRate { get; init; } = 44_100;

    /// <summary>32-byte audio key ("shk") used by <see cref="Ap2AudioPacket"/>.</summary>
    public byte[]? AudioKey { get; init; }

    /// <summary>Local UDP port that receives the receiver's control channel (if any).</summary>
    public int ControlPort { get; init; }

    /// <summary>Local UDP port that receives NTP timing requests.</summary>
    public int TimingPort { get; init; }

    public int LatencyMin { get; init; } = 11_025;

    public int LatencyMax { get; init; } = 88_200;

    public string TimingProtocol { get; init; } = "NTP";

    public string? DeviceId { get; init; }

    /// <summary>uint32 session id that doubles as the stream connection id.</summary>
    public int SessionId { get; init; }

    /// <summary>32-bit stream connection id (the sender's SSRC); 0 falls back to <see cref="SessionId"/>.</summary>
    public long StreamConnectionId { get; init; }

    /// <summary>True when the payload is ALAC (determines the <c>audioFormat</c> flag).</summary>
    public bool UseAlac { get; init; } = true;
}

/// <summary>Options for the connection-level (phase 1) AP2 SETUP: no <c>streams</c> array.</summary>
internal sealed class Ap2SessionSetupOptions
{
    public string? DeviceId { get; init; }

    public string? MacAddress { get; init; }

    public string? SessionUuid { get; init; }

    /// <summary>Local UDP port that receives the receiver's timing packets.</summary>
    public int TimingPort { get; init; }

    public string TimingProtocol { get; init; } = "NTP";

    public string Name { get; init; } = "Zilux2";

    public string Model { get; init; } = "iPhone14,3";

    public string OsName { get; init; } = "Windows";

    public string OsVersion { get; init; } = "10.0";

    public string OsBuildVersion { get; init; } = "19045";

    public string SourceVersion { get; init; } = "690.7.1";

    public bool IsMultiSelectAirPlay { get; init; } = true;

    public bool GroupContainsGroupLeader { get; init; }

    public string? GroupUuid { get; init; }

    public string? TimingPeerId { get; init; }

    /// <summary>PTP master clock identity advertised in <c>timingPeerInfo.ClockID</c>.</summary>
    public ulong TimingPeerClockId { get; init; }

    public IReadOnlyList<string>? TimingPeerAddresses { get; init; }
}

/// <summary>One stream entry returned by the receiver in the <c>SETUP</c> response.</summary>
internal sealed class Ap2StreamInfo
{
    public int Type { get; init; }

    public int StreamId { get; init; }

    /// <summary>UDP port that receives AP2 audio packets.</summary>
    public int DataPort { get; init; }

    /// <summary>UDP port that receives the sender's control packets (0xD6/0xD7).</summary>
    public int ControlPort { get; init; }

    public int AudioPort { get; init; }
}

/// <summary>Parsed <c>SETUP</c> response.</summary>
internal sealed class Ap2SetupResult
{
    public int ServicePort { get; init; }

    public int ControlPort { get; init; }

    public int TimingPort { get; init; }

    public int EventPort { get; init; }

    /// <summary>The receiver asked the sender to skip the RTSP <c>RECORD</c> step.</summary>
    public bool SkipRecord { get; init; }

    public IReadOnlyList<Ap2StreamInfo> Streams { get; init; } = [];

    public byte[] Raw { get; init; } = [];
}

/// <summary>
/// AirPlay 2 <c>SETUP</c>: builds the binary-plist request body carrying the audio stream
/// description and parses the receiver's plist response (stream ports). See
/// <c>research/airplay/protocol/ap2-flow.md</c> §3 for the field rationale.
/// </summary>
internal static class Ap2Setup
{
    public const string ContentType = "application/x-apple-binary-plist";

    public const int RealtimeAudioStreamType = 96;

    public const int BufferedAudioStreamType = 103;

    public const int PcmCompressionType = 1;

    public const int AlacCompressionType = 2;

    public static readonly IReadOnlyList<KeyValuePair<string, string>> EmptyHeaders = [];

    /// <summary>Serializes <see cref="Ap2SetupOptions"/> into the AP2 SETUP request body.</summary>
    public static byte[] BuildBody(Ap2SetupOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.AudioKey is not { Length: 32 })
        {
            throw new ArgumentException("SETUP requires a 32-byte audio key (shk).", nameof(options));
        }

        var stream = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["type"] = options.StreamType,
            ["ct"] = options.CompressionType,
            ["spf"] = options.FramesPerPacket,
            ["sr"] = options.SampleRate,
            ["shk"] = options.AudioKey,
        };

        var root = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["streams"] = new object?[] { stream },
            ["timingProtocol"] = options.TimingProtocol,
            ["latencyMin"] = options.LatencyMin,
            ["latencyMax"] = options.LatencyMax,
            ["isMedia"] = true,
        };

        if (options.ControlPort > 0)
        {
            root["controlPort"] = options.ControlPort;
        }

        if (options.TimingPort > 0)
        {
            root["timingPort"] = options.TimingPort;
        }

        if (!string.IsNullOrEmpty(options.DeviceId))
        {
            root["deviceID"] = options.DeviceId;
        }

        return Bplist.Encode(root);
    }

    /// <summary>
    /// Audio format flag sent in the play-session stream entry. It is computed from the
    /// negotiated codec and sample rate (reference sender <c>audio_format()</c>):
    /// ALAC 44.1 kHz = <c>1 &lt;&lt; 18</c>, ALAC 48 kHz = <c>1 &lt;&lt; 20</c>,
    /// PCM 44.1 kHz = <c>1 &lt;&lt; 11</c>, PCM 48 kHz = <c>1 &lt;&lt; 15</c>.
    /// </summary>
    public const int AlacAudioFormat44100 = 1 << 18;

    /// <summary>ALAC 48 kHz audio format flag.</summary>
    public const int AlacAudioFormat48000 = 1 << 20;

    /// <summary>Linear PCM 44.1 kHz audio format flag.</summary>
    public const int PcmAudioFormat44100 = 1 << 11;

    /// <summary>Linear PCM 48 kHz audio format flag.</summary>
    public const int PcmAudioFormat48000 = 1 << 15;

    /// <summary>Returns the stream <c>audioFormat</c> flag for a codec/sample-rate pair.</summary>
    public static int AudioFormatFor(bool useAlac, int sampleRate)
    {
        var is48k = sampleRate == 48_000;
        if (useAlac)
        {
            return is48k ? AlacAudioFormat48000 : AlacAudioFormat44100;
        }

        return is48k ? PcmAudioFormat48000 : PcmAudioFormat44100;
    }

    /// <summary>Serializes the connection-level (phase 1) SETUP body: no <c>streams</c> array.</summary>
    public static byte[] BuildSessionBody(Ap2SessionSetupOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var root = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["deviceID"] = options.DeviceId ?? string.Empty,
            ["sessionUUID"] = options.SessionUuid ?? string.Empty,
            ["timingProtocol"] = options.TimingProtocol,
            ["isMultiSelectAirPlay"] = options.IsMultiSelectAirPlay,
            ["groupContainsGroupLeader"] = options.GroupContainsGroupLeader,
            ["macAddress"] = options.MacAddress ?? options.DeviceId ?? string.Empty,
            ["model"] = options.Model,
            ["name"] = options.Name,
            ["osBuildVersion"] = options.OsBuildVersion,
            ["osName"] = options.OsName,
            ["osVersion"] = options.OsVersion,
            ["senderSupportsRelay"] = false,
            ["sourceVersion"] = options.SourceVersion,
            ["statsCollectionEnabled"] = false,
        };

        if (options.TimingProtocol.Equals("PTP", StringComparison.OrdinalIgnoreCase))
        {
            var addresses = options.TimingPeerAddresses is { Count: > 0 } list
                ? list.Select(static address => (object?)address).ToArray()
                : [];
            var peer = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ID"] = options.TimingPeerId ?? string.Empty,
                ["DeviceType"] = 0L,
                ["ClockID"] = (long)options.TimingPeerClockId,
                ["SupportsClockPortMatchingOverride"] = false,
                ["Addresses"] = addresses,
            };
            root["timingPeerInfo"] = peer;
            root["timingPeerList"] = new object?[] { peer };

            if (!string.IsNullOrEmpty(options.GroupUuid))
            {
                root["groupUUID"] = options.GroupUuid;
            }
        }
        else if (options.TimingPort > 0)
        {
            root["timingPort"] = options.TimingPort;
        }

        return Bplist.Encode(root);
    }

    /// <summary>Serializes the play-session (phase 2) SETUP body: root contains only <c>streams</c>.</summary>
    public static byte[] BuildStreamBody(Ap2SetupOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (options.AudioKey is not { Length: 32 })
        {
            throw new ArgumentException("SETUP requires a 32-byte audio key (shk).", nameof(options));
        }

        var connectionId = options.StreamConnectionId != 0
            ? options.StreamConnectionId
            : (long)(uint)options.SessionId;
        var stream = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["audioFormat"] = AudioFormatFor(options.UseAlac, options.SampleRate),
            ["audioMode"] = "default",
            ["controlPort"] = options.ControlPort,
            ["ct"] = options.UseAlac ? AlacCompressionType : PcmCompressionType,
            ["isMedia"] = true,
            ["latencyMax"] = options.LatencyMax,
            ["latencyMin"] = options.LatencyMin,
            ["shk"] = options.AudioKey,
            ["spf"] = options.FramesPerPacket,
            ["sr"] = options.SampleRate,
            ["type"] = options.StreamType,
            ["supportsDynamicStreamID"] = false,
            ["streamConnectionID"] = connectionId,
        };

        var root = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["streams"] = new object?[] { stream },
        };

        return Bplist.Encode(root);
    }

    /// <summary>Headers for the encrypted SETUP request (CSeq is added by the transport).</summary>
    public static List<KeyValuePair<string, string>> BuildHeaders(string userAgent, string? sessionId = null)
    {
        var headers = new List<KeyValuePair<string, string>>(4)
        {
            new("Content-Type", ContentType),
            new("User-Agent", userAgent),
        };

        if (!string.IsNullOrEmpty(sessionId))
        {
            headers.Add(new KeyValuePair<string, string>("Session", sessionId));
        }

        return headers;
    }

    /// <summary>
    /// Serialises the <c>SETPEERS</c> body: a plist array of the PTP peers' host addresses
    /// (including this sender's own address). Sent on the encrypted control channel after the
    /// event channel is up and before the play-session SETUP when timing is PTP.
    /// </summary>
    public static byte[] BuildSetPeersBody(IReadOnlyList<string> peers)
    {
        ArgumentNullException.ThrowIfNull(peers);
        return Bplist.Encode(peers.Select(static peer => (object?)peer).ToArray());
    }

    /// <summary>Parses the SETUP response plist; missing keys default to 0 instead of throwing.</summary>
    public static Ap2SetupResult ParseResponse(ReadOnlySpan<byte> body)
    {
        if (body.Length == 0)
        {
            throw new InvalidDataException("The AirPlay 2 SETUP response has no body.");
        }

        var root = Bplist.Decode(body) as Dictionary<string, object?>
            ?? throw new InvalidDataException("The AirPlay 2 SETUP response is not a dictionary.");

        var streams = new List<Ap2StreamInfo>();
        var streamArray = root.TryGetValue("streams", out var streamsValue) ? streamsValue as object?[] : null;
        if (streamArray is not null)
        {
            foreach (var entry in streamArray)
            {
                if (entry is not Dictionary<string, object?> stream)
                {
                    continue;
                }

                streams.Add(new Ap2StreamInfo
                {
                    Type = ReadInt(stream, "type"),
                    StreamId = ReadInt(stream, "streamID"),
                    DataPort = ReadInt(stream, "dataPort"),
                    ControlPort = ReadInt(stream, "controlPort"),
                    AudioPort = ReadInt(stream, "audioPort"),
                });
            }
        }

        return new Ap2SetupResult
        {
            ServicePort = ReadInt(root, "servicePort"),
            ControlPort = ReadInt(root, "controlPort"),
            TimingPort = ReadInt(root, "timingPort"),
            EventPort = ReadInt(root, "eventPort"),
            SkipRecord = ReadBool(root, "skipRecord"),
            Streams = streams,
            Raw = body.ToArray(),
        };
    }

    internal static bool ReadBool(Dictionary<string, object?> dictionary, string key)
    {
        if (!dictionary.TryGetValue(key, out var value))
        {
            return false;
        }

        return value switch
        {
            bool b => b,
            long l => l != 0,
            int i => i != 0,
            _ => false,
        };
    }

    internal static int ReadInt(Dictionary<string, object?> dictionary, string key)
    {
        if (!dictionary.TryGetValue(key, out var value))
        {
            return 0;
        }

        return value switch
        {
            long l => (int)l,
            int i => i,
            ulong ul => (int)ul,
            uint ui => (int)ui,
            short s => s,
            byte b => b,
            _ => 0,
        };
    }
}
