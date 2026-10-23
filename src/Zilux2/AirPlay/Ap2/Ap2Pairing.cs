using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Zilux2.AirPlay.Crypto;
using Zilux2.AirPlay.Protocol;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// Adapter that bridges the frozen crypto pairing surface
/// (<see cref="Zilux2.AirPlay.Crypto.HapPairing"/>) into the AP2 transport layer.
/// The connection starts in plaintext; <see cref="HapPairing.TransientAsync"/> performs
/// pair-setup over that plaintext channel and returns the two ChaCha20-Poly1305 channel keys,
/// which are then wrapped as <see cref="IFrameCryptor"/> so <see cref="HapEncryptedTransport"/>
/// can switch the same TCP socket to HAP frames.
/// </summary>
internal static class Ap2Pairing
{
    /// <summary>Default User-Agent for pairing requests (devices whitelist Apple UAs).</summary>
    public const string DefaultUserAgent = "AirPlay/320.20";

    /// <summary>
    /// Creates the pairing delegate for <see cref="Ap2Connection.Connect"/>.
    /// Transient pairing needs no PIN and no persisted credentials, which is the path
    /// HomePod / Apple TV accept for AirPlay 2 audio.
    /// </summary>
    /// <param name="userAgent">User-Agent override; null keeps the crypto layer default.</param>
    /// <param name="trace">Optional diagnostic sink for the TLV exchange.</param>
    public static Ap2PairingHandler CreateTransientHandler(string? userAgent = null, Action<string>? trace = null)
        => (channel, cancellationToken) => TransientAsync(channel, userAgent, trace, cancellationToken);

    /// <summary>
    /// Creates a pairing delegate for receivers that reject transient pairing and require the
    /// on-screen PIN instead (macOS "AirPlay Receiver" returns HTTP 470 to a transient M1).
    /// The delegate runs pair-pin-start + pair-setup (PIN, SRP-3072) followed by pair-verify,
    /// and returns the verify session keys for the control channel.
    /// </summary>
    public static Ap2PairingHandler CreatePinHandler(
        Func<CancellationToken, Task<string>> pinProvider,
        string? userAgent = null,
        Action<string>? trace = null)
    {
        ArgumentNullException.ThrowIfNull(pinProvider);
        return (channel, cancellationToken) => PinAsync(channel, pinProvider, userAgent, trace, cancellationToken);
    }

    /// <summary>Runs HAP PIN pair-setup + pair-verify on an already connected plaintext transport.</summary>
    public static async Task<Ap2PairingResult> PinAsync(
        HapEncryptedTransport channel,
        Func<CancellationToken, Task<string>> pinProvider,
        string? userAgent = null,
        Action<string>? trace = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(channel);
        ArgumentNullException.ThrowIfNull(pinProvider);

        var transport = CreateTransport(channel, userAgent);

        // pair-pin-start fires inside SetupAsync: the receiver shows its 4-digit PIN while the
        // first pair-setup round-trip is in flight, and pinProvider waits for the user.
        var credentials = await HapPairing.SetupAsync(transport, pinProvider, cancellationToken, trace)
            .ConfigureAwait(false);
        trace?.Invoke($"pair-setup complete: accessoryId={credentials.AccessoryId.Length}B ltPK={credentials.AccessoryLtpk.Length}B");

        var verify = await HapPairing.VerifyAsync(transport, credentials, cancellationToken, trace)
            .ConfigureAwait(false);
        trace?.Invoke($"pair-verify complete: secret={verify.SharedSecret.Length}B");

        var session = verify.CreateControlSession();
        var cryptor = new HapSessionFrameCryptor(session);
        return new Ap2PairingResult
        {
            WriteCryptor = cryptor,
            ReadCryptor = cryptor,
            SharedSecret = verify.SharedSecret,
        };
    }

    /// <summary>
    /// Pairing delegate for receivers that require PIN pairing but can remember this controller
    /// (macOS "AirPlay Receiver"): stored credentials are tried with pair-verify first, and only a
    /// fresh install / revoked pairing falls back to pair-pin-start + PIN.
    /// </summary>
    public static Ap2PairingHandler CreateStoredPinHandler(
        string host,
        Func<CancellationToken, Task<string>> pinProvider,
        string? userAgent = null,
        Action<string>? trace = null)
    {
        ArgumentException.ThrowIfNullOrEmpty(host);
        ArgumentNullException.ThrowIfNull(pinProvider);
        return (channel, cancellationToken) => StoredPinAsync(host, channel, pinProvider, userAgent, trace, cancellationToken);
    }

    /// <summary>pair-verify with stored credentials; falls back to PIN pair-setup when that fails.</summary>
    public static async Task<Ap2PairingResult> StoredPinAsync(
        string host,
        HapEncryptedTransport channel,
        Func<CancellationToken, Task<string>> pinProvider,
        string? userAgent = null,
        Action<string>? trace = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(host);
        ArgumentNullException.ThrowIfNull(channel);
        ArgumentNullException.ThrowIfNull(pinProvider);

        var transport = CreateTransport(channel, userAgent);

        if (Ap2PairingStore.TryLoad(host, out var stored))
        {
            try
            {
                var verified = await HapPairing.VerifyAsync(transport, stored, cancellationToken, trace)
                    .ConfigureAwait(false);
                trace?.Invoke($"pair-verify with stored credentials ok: secret={verified.SharedSecret.Length}B");
                return CreateResult(verified);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                // The receiver forgot or revoked us, so start over with the on-screen PIN.
                trace?.Invoke($"pair-verify failed ({exception.GetType().Name}: {exception.Message}); pairing again");
                Ap2PairingStore.Delete(host);
            }
        }

        // macOS sometimes ignores the pair-pin-start issued on the RTSP pairing socket but always
        // answers a plain HTTP POST, so prime the on-screen PIN on a throw-away connection first.
        await PrimePinStartAsync(host, userAgent, trace, cancellationToken).ConfigureAwait(false);

        var credentials = await HapPairing.SetupAsync(transport, pinProvider, cancellationToken, trace)
            .ConfigureAwait(false);
        trace?.Invoke($"pair-setup complete: accessoryId={credentials.AccessoryId.Length}B ltPK={credentials.AccessoryLtpk.Length}B");

        var verify = await HapPairing.VerifyAsync(transport, credentials, cancellationToken, trace)
            .ConfigureAwait(false);
        Ap2PairingStore.Save(host, credentials);
        trace?.Invoke($"pair-verify complete: secret={verify.SharedSecret.Length}B");

        return CreateResult(verify);
    }

    private static Ap2PairingResult CreateResult(HapVerifyResult verify)
    {
        var cryptor = new HapSessionFrameCryptor(verify.CreateControlSession());
        return new Ap2PairingResult
        {
            WriteCryptor = cryptor,
            ReadCryptor = cryptor,
            SharedSecret = verify.SharedSecret,
        };
    }

    /// <summary>
    /// Primes the receiver's on-screen PIN over a plain HTTP connection before the pairing session.
    /// macOS "AirPlay Receiver" reliably answers this shape of request (it is exactly what curl
    /// sends) even when it ignores the pair-pin-start pipelined onto the RTSP socket.
    /// </summary>
    private static async Task PrimePinStartAsync(
        string host,
        string? userAgent,
        Action<string>? trace,
        CancellationToken cancellationToken)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://{host}:7000/pair-pin-start")
            {
                Content = new ByteArrayContent(Array.Empty<byte>()),
            };
            request.Content.Headers.ContentType =
                new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
            request.Headers.TryAddWithoutValidation("User-Agent", userAgent ?? DefaultUserAgent);
            request.Headers.TryAddWithoutValidation("X-Apple-HKP", "3");

            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            trace?.Invoke($"pair-pin-start (http) → {(int)response.StatusCode}");
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Not fatal: SetupAsync still issues its own pair-pin-start over the RTSP socket.
            trace?.Invoke($"pair-pin-start (http) failed, ignored: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>Runs transient HAP pair-setup on an already connected plaintext transport.</summary>
    public static async Task<Ap2PairingResult> TransientAsync(
        HapEncryptedTransport channel,
        string? userAgent = null,
        Action<string>? trace = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(channel);

        var verify = await HapPairing.TransientAsync(
            CreateTransport(channel, userAgent),
            cancellationToken,
            trace).ConfigureAwait(false);

        // One session object owns both directions (separate write/read counters), so the same
        // cryptor can be used for the write and the read side.
        var session = verify.CreateControlSession();
        var cryptor = new HapSessionFrameCryptor(session);
        return new Ap2PairingResult
        {
            WriteCryptor = cryptor,
            ReadCryptor = cryptor,
            SharedSecret = verify.SharedSecret,
        };
    }

    /// <summary>Binds the crypto pairing transport to the live plaintext control socket.</summary>
    private static HapPairingTransport CreateTransport(HapEncryptedTransport channel, string? userAgent) =>
        (method, path, headers, body, cancellationToken) =>
            Task.FromResult(SendPairingRequest(channel, method, path, headers, body, userAgent));

    private static HapHttpResponse SendPairingRequest(
        HapEncryptedTransport channel,
        string method,
        string path,
        IReadOnlyDictionary<string, string> headers,
        byte[] body,
        string? userAgent)
    {
        var pairs = new List<KeyValuePair<string, string>>(headers.Count + 1);
        foreach (var (key, value) in headers)
        {
            if (userAgent is not null && string.Equals(key, "User-Agent", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            pairs.Add(new KeyValuePair<string, string>(key, value));
        }

        if (userAgent is not null)
        {
            pairs.Add(new KeyValuePair<string, string>("User-Agent", userAgent));
        }

        // Pairing is an HTTP-shaped exchange on the RTSP port; HomePod accepts the HTTP/1.1 spelling.
        var response = channel.Send(method, path, pairs, body, "HTTP/1.1");
        return new HapHttpResponse
        {
            StatusCode = response.StatusCode,
            ContentType = response.Header("Content-Type"),
            Body = response.Body,
            Headers = response.Headers,
        };
    }
}

/// <summary>Wraps the crypto layer's HAP session as the transport's byte-stream codec.</summary>
internal sealed class HapSessionFrameCryptor : IFrameCryptor, IDisposable
{
    private readonly HapSessionCrypt _session;

    public HapSessionFrameCryptor(HapSessionCrypt session)
    {
        ArgumentNullException.ThrowIfNull(session);
        _session = session;
    }

    public int BufferedCiphertextLength => _session.BufferedCiphertextLength;

    public byte[] Encrypt(ReadOnlySpan<byte> plaintext) => _session.Encrypt(plaintext);

    public byte[] Decrypt(ReadOnlySpan<byte> ciphertext) => _session.Decrypt(ciphertext);

    public void Dispose() => _session.Dispose();
}
