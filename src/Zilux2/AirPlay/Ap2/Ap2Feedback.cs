using System.Threading;
using Zilux2.AirPlay.Protocol;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// AP2 keep-alive: after <c>RECORD</c> the sender must issue <c>POST /feedback</c> on the encrypted
/// RTSP channel roughly every two seconds; receivers drop the session when it stops. The body is a
/// tiny binary plist (<c>{'streams': []}</c>) and the response mirrors that shape.
/// </summary>
internal sealed class Ap2Feedback : IDisposable
{
    public static readonly TimeSpan DefaultInterval = TimeSpan.FromSeconds(2);

    private readonly HapEncryptedTransport _transport;
    private readonly TimeSpan _interval;
    private readonly Timer _timer;
    private readonly object _gate = new();
    private int _count;
    private int _lastStatus;
    private string? _lastError;
    private bool _disposed;

    public Ap2Feedback(HapEncryptedTransport transport, TimeSpan? interval = null, string userAgent = "iTunes/12.12.10 (Windows; Microsoft Windows 10 x64)")
    {
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
        _interval = interval ?? DefaultInterval;
        UserAgent = userAgent;
        _timer = new Timer(OnTick, null, Timeout.Infinite, Timeout.Infinite);
    }

    public string UserAgent { get; }

    /// <summary>Number of feedback requests actually sent.</summary>
    public int Count => Volatile.Read(ref _count);

    /// <summary>HTTP/RTSP status of the most recent request (0 until the first one completes).</summary>
    public int LastStatus => Volatile.Read(ref _lastStatus);

    /// <summary>Last transport or status failure, if any.</summary>
    public string? LastError => Volatile.Read(ref _lastError);

    public bool LastResponseOk => LastStatus == 200;

    public void Start() => _timer.Change(TimeSpan.Zero, _interval);

    public void Stop() => _timer.Change(Timeout.Infinite, Timeout.Infinite);

    private void OnTick(object? state)
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            try
            {
                var body = Bplist.Encode(new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["streams"] = Array.Empty<object?>(),
                });

                var headers = new List<KeyValuePair<string, string>>(2)
                {
                    new("Content-Type", Ap2Setup.ContentType),
                    new("User-Agent", UserAgent),
                };

                var response = _transport.Send("POST", "/feedback", headers, body);
                Volatile.Write(ref _lastStatus, response.StatusCode);
                _ = Interlocked.Increment(ref _count);
                if (response.StatusCode != 200)
                {
                    Volatile.Write(ref _lastError, $"feedback returned {response.StatusCode} {response.Reason}");
                }
                else
                {
                    Volatile.Write(ref _lastError, null);
                }
            }
            catch (Exception ex)
            {
                Volatile.Write(ref _lastError, $"{ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
        }

        _timer.Change(Timeout.Infinite, Timeout.Infinite);
        _timer.Dispose();
    }
}
