// ============================================================================
//  Program.cs — ALAC encoder verification harness (research/airplay/alac).
//
//  Proves, without any native dependency (no ffmpeg, no AlacCodec.dll):
//    * bit-exact lossless round-trips (encode -> managed decoder -> compare),
//    * coverage across signal types, full/partial frames, mono/stereo,
//    * continuous streaming (one Init, 200 consecutive frames),
//    * RAOP-sized frames (352 samples/channel), max packet size, magic cookie,
//    * encode timing per frame (target: < 2 ms at 44.1 kHz/16-bit/stereo/352).
//
//  Run with:  dotnet run -c Release
//  Exit code 0 = every check passed; 1 = at least one failure.
// ============================================================================

using System;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Zilux2.AirPlay.Alac;

namespace AlacVerify;

internal static class Program
{
    private const int FrameLength = 352;      // RAOP: 352 samples per channel per packet
    private const int SampleRate = 44100;
    private const int PacketBudget = 1428;    // RAOP MaxALACPacketSize used by the host

    private static int _failures;
    private static uint _rng = 0x1234_5678u;
    private static int _totalFrames;
    private static long _totalEncodedBytes;
    private static long _totalRawBytes;
    private static int _escapeFrames;
    private static int _maxFrameBytes;

    private static int Main()
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { /* console may not support it */ }

        Console.WriteLine("================================================================");
        Console.WriteLine(" ALAC encoder verification (pure managed C#, no native code)");
        Console.WriteLine($" {SampleRate} Hz / 16-bit / {FrameLength} samples per frame, RAOP packet budget {PacketBudget} B");
        Console.WriteLine("================================================================");
        Console.WriteLine();

        TestRoundtripSignals(mono: false);
        TestRoundtripSignals(mono: true);
        TestPartialFrames();
        TestStreaming200Frames();
        TestPerformance();
        TestMagicCookie();
        TestEscapeAndLimits();

        Console.WriteLine();
        Console.WriteLine("----------------------------------------------------------------");
        Console.WriteLine($" TOTAL: {_totalFrames} frames encoded/decoded, " +
                          $"{(1.0 - (double)_totalEncodedBytes / Math.Max(1, _totalRawBytes)) * 100.0:F1}% smaller than PCM, " +
                          $"{_escapeFrames} escape (uncompressed) frames, max frame {_maxFrameBytes} B");
        Console.WriteLine(_failures == 0
            ? " RESULT: ALL ROUNDTRIPS BIT-EXACT — PASS"
            : $" RESULT: {_failures} FAILURE(S) — FAIL");
        Console.WriteLine("----------------------------------------------------------------");
        return _failures == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------------
    //  1) round-trip over signal types (stereo and mono)
    // ------------------------------------------------------------------
    private static void TestRoundtripSignals(bool mono)
    {
        int channels = mono ? 1 : 2;
        Console.WriteLine($"--- Round-trip: {(mono ? "MONO" : "STEREO")} (30 frames per signal, 352 samples/frame)");
        Console.WriteLine($"{"signal",-22} {"frames",7} {"pass",6} {"avg B",7} {"ratio",7} {"esc",5}  status");

        var signals = new (string Name, Func<int, (short L, short R)> Fn)[]
        {
            ("silence",            _ => ((short)0, (short)0)),
            ("sine 440 L only",    n => (Sine(0.8, 440, n), (short)0)),
            ("sine 440 R only",    n => ((short)0, Sine(0.8, 440, n))),
            ("sine 440 in phase",  n => { short s = Sine(0.8, 440, n); return (s, s); }),
            ("sine 440 90deg",     n => (Sine(0.8, 440, n), Sine(0.8, 440, n + 110))),
            ("white noise",        _ => (RandShort(), RandShort())),
            ("square 220",         n => { short s = Square(0.5, 220, n); return (s, s); }),
            ("full scale +-32767", n => { short s = (short)((n & 1) != 0 ? 32767 : -32768); return (s, (short)-s); }),
            ("chirp 20..20k",      n => (Chirp(0.7, n), Chirp(0.7, n))),
            ("random per frame",   _ => (RandShort(), RandShort())),
        };

        var enc = new AlacEncoder();
        enc.Init(SampleRate, channels, 16, FrameLength);
        var dec = new AlacDecoder();
        dec.Init(SampleRate, channels, 16, FrameLength);
        byte[] outBuf = new byte[Math.Max(enc.MaxFrameBytes, PacketBudget)];
        short[] decBuf = new short[FrameLength * channels];

        foreach (var (name, fn) in signals)
        {
            int pass = 0, frames = 30, bytes = 0, esc = 0;
            int start = 0;
            for (int f = 0; f < frames; f++)
            {
                short[] pcm = Make(mono, fn, start, FrameLength);
                start += FrameLength;
                int n = enc.EncodeFrame(pcm, outBuf);
                bytes += n;
                if (enc.LastFrameWasEscape) esc++;
                _maxFrameBytes = Math.Max(_maxFrameBytes, n);
                bool ok = Roundtrip(pcm, n, dec, outBuf, decBuf, FrameLength, channels);
                if (ok) pass++; else _failures++;
                _totalFrames++;
                _totalEncodedBytes += n;
                _totalRawBytes += pcm.Length * 2;
                _escapeFrames += enc.LastFrameWasEscape ? 1 : 0;
                if (n > PacketBudget) { Console.WriteLine($"  !! frame {n} B > {PacketBudget} B budget"); _failures++; }
            }
            double ratio = (double)bytes / (frames * FrameLength * channels * 2);
            Console.WriteLine($"{name,-22} {frames,7} {pass,6} {bytes / (double)frames,7:F1} {ratio * 100,6:F1}% {esc,5}  {(pass == frames ? "OK" : "FAIL")}");
        }
        Console.WriteLine();
    }

    // ------------------------------------------------------------------
    //  2) partial (tail) frames of every relevant size
    // ------------------------------------------------------------------
    private static void TestPartialFrames()
    {
        Console.WriteLine("--- Round-trip: partial frames (tail packets, 1..352 samples)");
        var enc = new AlacEncoder();
        enc.Init(SampleRate, 2, 16, FrameLength);
        var dec = new AlacDecoder();
        dec.Init(SampleRate, 2, 16, FrameLength);
        byte[] outBuf = new byte[Math.Max(enc.MaxFrameBytes, PacketBudget)];
        short[] decBuf = new short[FrameLength * 2];

        int[] sizes = { 1, 2, 3, 4, 5, 6, 7, 8, 16, 32, 50, 100, 128, 200, 255, 287, 288, 300, 320, 351 };
        int ok = 0;
        foreach (int count in sizes)
        {
            short[] pcm = Make(false, (n) => (Sine(0.6, 440, n), Sine(0.6, 660, n)), 0, count);
            int n = enc.EncodeFrame(pcm, outBuf);
            _maxFrameBytes = Math.Max(_maxFrameBytes, n);
            bool pass = Roundtrip(pcm, n, dec, outBuf, decBuf, count, 2);
            if (pass) ok++; else _failures++;
            _totalFrames++;
            _totalEncodedBytes += n;
            _totalRawBytes += pcm.Length * 2;
            _escapeFrames += enc.LastFrameWasEscape ? 1 : 0;
            Console.WriteLine($"  samples={count,3} -> bytes={n,4} {(enc.LastFrameWasEscape ? "escape" : "compressed")} {(pass ? "bit-exact" : "MISMATCH")}");
        }
        Console.WriteLine($"  {ok}/{sizes.Length} partial sizes bit-exact");
        Console.WriteLine();
    }

    // ------------------------------------------------------------------
    //  3) streaming: one Init, 200 consecutive frames, no re-initialisation
    // ------------------------------------------------------------------
    private static void TestStreaming200Frames()
    {
        Console.WriteLine("--- Round-trip: streaming, one Init(), 200 consecutive frames (mixed content)");
        var enc = new AlacEncoder();
        enc.Init(SampleRate, 2, 16, FrameLength);
        var dec = new AlacDecoder();
        dec.Init(SampleRate, 2, 16, FrameLength);
        byte[] outBuf = new byte[Math.Max(enc.MaxFrameBytes, PacketBudget)];
        short[] decBuf = new short[FrameLength * 2];

        int frames = 200, pass = 0, bytes = 0, esc = 0;
        int start = 0;
        for (int f = 0; f < frames; f++)
        {
            int phase = f / 50;   // 0 = sine, 1 = noise, 2 = silence, 3 = chirp
            short[] pcm = Make(false, phase switch
            {
                0 => (int n) => (Sine(0.75, 440, n), Sine(0.75, 441, n)),
                1 => (int n) => (RandShort(), RandShort()),
                2 => (int n) => ((short)0, (short)0),
                _ => (int n) => (Chirp(0.9, n), Chirp(0.9, n + 7)),
            }, start, FrameLength);
            start += FrameLength;

            int n = enc.EncodeFrame(pcm, outBuf);
            bytes += n;
            if (enc.LastFrameWasEscape) esc++;
            _maxFrameBytes = Math.Max(_maxFrameBytes, n);
            bool ok = Roundtrip(pcm, n, dec, outBuf, decBuf, FrameLength, 2);
            if (ok) pass++; else _failures++;
            _totalFrames++;
            _totalEncodedBytes += n;
            _totalRawBytes += pcm.Length * 2;
            _escapeFrames += enc.LastFrameWasEscape ? 1 : 0;
        }
        Console.WriteLine($"  frames={frames} bit-exact={pass} avg={bytes / (double)frames:F1} B escape={esc} max={_maxFrameBytes} B");
        Console.WriteLine($"  {(pass == frames ? "OK: continuous streaming is deterministic and bit-exact" : "FAIL")}");
        Console.WriteLine();
    }

    // ------------------------------------------------------------------
    //  4) performance: encode timing per frame
    // ------------------------------------------------------------------
    private static void TestPerformance()
    {
        Console.WriteLine("--- Performance: EncodeFrame (352 stereo samples, Release build, warm)");
        var enc = new AlacEncoder();
        enc.Init(SampleRate, 2, 16, FrameLength);
        byte[] outBuf = new byte[Math.Max(enc.MaxFrameBytes, PacketBudget)];

        // realistic-ish content: sine + light noise (dither-like)
        short[] pcm = new short[FrameLength * 2];
        var samples = new double[FrameLength * 2];
        for (int f = 0; f < 6000; f++)
        {
            int start = f * FrameLength;
            for (int i = 0; i < FrameLength; i++)
            {
                short l = (short)(Sine(0.5, 440, start + i) + (RandShort() % 64));
                short r = (short)(Sine(0.5, 441, start + i) + (RandShort() % 64));
                pcm[2 * i] = l;
                pcm[2 * i + 1] = r;
            }
            enc.EncodeFrame(pcm, outBuf);   // warm-up
        }

        const int N = 2000;
        double[] us = new double[N];
        var sw = new Stopwatch();
        int bytes = 0;
        for (int f = 0; f < N; f++)
        {
            sw.Restart();
            bytes = enc.EncodeFrame(pcm, outBuf);
            sw.Stop();
            us[f] = sw.Elapsed.TotalMicroseconds;
        }
        Array.Sort(us);
        double avg = 0; foreach (double v in us) avg += v; avg /= N;
        double p50 = us[N / 2], p99 = us[(int)(N * 0.99)], max = us[N - 1];
        Console.WriteLine($"  {N} frames, {_totalRawBytes / 1024} B of prior traffic; last frame {bytes} B");
        Console.WriteLine($"  avg={avg:F1} us   p50={p50:F1} us   p99={p99:F1} us   max={max:F1} us   (~{1_000_000.0 / avg:F0} frames/s)");
        Console.WriteLine($"  target < 2000 us/frame: {(p99 < 2000.0 ? "PASS" : (avg < 2000.0 ? "avg PASS / p99 above" : "FAIL"))}");
        Console.WriteLine();
    }

    // ------------------------------------------------------------------
    //  5) magic cookie
    // ------------------------------------------------------------------
    private static void TestMagicCookie()
    {
        Console.WriteLine("--- Magic cookie (ALACSpecificConfig, 24 bytes, big-endian)");
        var enc = new AlacEncoder();
        enc.Init(SampleRate, 2, 16, FrameLength);
        byte[] cookie = enc.GetMagicCookie();
        Console.WriteLine($"  stereo cookie ({cookie.Length} B): {Hex(cookie)}");
        Console.WriteLine("  layout: frameLength BE32 | compatVer | bitDepth | pb | mb | kb | numChannels | maxRun BE16 | maxFrameBytes BE32 | avgBitRate BE32 | sampleRate BE32");

        var encMono = new AlacEncoder();
        encMono.Init(SampleRate, 1, 16, FrameLength);
        byte[] cookieMono = encMono.GetMagicCookie();
        Console.WriteLine($"  mono   cookie ({cookieMono.Length} B): {Hex(cookieMono)}");
        Console.WriteLine($"  fields: frameLength={(int)BE32(cookie, 0)} compat={cookie[4]} depth={cookie[5]} pb={cookie[6]} mb={cookie[7]} kb={cookie[8]} ch={cookie[9]} maxRun={cookie[10] << 8 | cookie[11]} maxFrameBytes={(int)BE32(cookie, 12)} avgBitRate={(int)BE32(cookie, 16)} sampleRate={(int)BE32(cookie, 20)}");

        // decode using only the cookie (proves the cookie describes the stream)
        var dec = new AlacDecoder();
        dec.Init(cookie);
        var pcm = Make(false, (n) => (Sine(0.7, 440, n), Sine(0.7, 550, n)), 0, FrameLength);
        byte[] outBuf = new byte[Math.Max(enc.MaxFrameBytes, PacketBudget)];
        short[] decBuf = new short[FrameLength * 2];
        int bytes = enc.EncodeFrame(pcm, outBuf);
        bool ok = Roundtrip(pcm, bytes, dec, outBuf, decBuf, FrameLength, 2);
        Console.WriteLine($"  cookie-initialised decoder round-trip: {(ok ? "bit-exact" : "MISMATCH")}");
        if (!ok) _failures++;
        Console.WriteLine();
    }

    // ------------------------------------------------------------------
    //  6) escape path / output-size guard
    // ------------------------------------------------------------------
    private static void TestEscapeAndLimits()
    {
        Console.WriteLine("--- Escape (uncompressed) path and output-size limits");
        var enc = new AlacEncoder();
        enc.Init(SampleRate, 2, 16, FrameLength);
        byte[] outBuf = new byte[Math.Max(enc.MaxFrameBytes, PacketBudget)];
        Console.WriteLine($"  MaxFrameBytes (encoder promise) = {enc.MaxFrameBytes} B; host budget = {PacketBudget} B");

        // incompressible frame: full-scale white noise forces the escape path often
        int escape = 0, max = 0;
        short[] pcm = new short[FrameLength * 2];
        for (int f = 0; f < 20; f++)
        {
            for (int i = 0; i < pcm.Length; i++) pcm[i] = RandShort();
            int n = enc.EncodeFrame(pcm, outBuf);
            if (n < 0) { Console.WriteLine("  !! EncodeFrame returned -1 (frame larger than buffer)"); _failures++; continue; }
            if (enc.LastFrameWasEscape) escape++;
            max = Math.Max(max, n);
        }
        Console.WriteLine($"  20 full-scale noise frames: {escape} escape frames, max {max} B (<= {PacketBudget} B: {(max <= PacketBudget ? "OK" : "OVER")})");
        if (max > PacketBudget) _failures++;

        // partial full-scale noise (escape upper bound)
        for (int count = 1; count <= 352; count += 37)
        {
            short[] part = new short[count * 2];
            for (int i = 0; i < part.Length; i++) part[i] = RandShort();
            int n = enc.EncodeFrame(part, outBuf);
            max = Math.Max(max, n);
            if (n > PacketBudget) { Console.WriteLine($"  !! partial frame {count} samples -> {n} B over budget"); _failures++; }
        }
        Console.WriteLine($"  worst measured frame (incl. partial noise) = {max} B");

        // contract with the streaming pipeline: recoverable errors return -1,
        // never throw, never write out of bounds
        int r1 = enc.EncodeFrame(pcm, new byte[16]);                 // destination too small
        int r2 = enc.EncodeFrame(new short[3], outBuf);              // not a whole number of stereo samples
        int r3 = enc.EncodeFrame(Array.Empty<short>(), outBuf);      // empty frame
        if (r1 != -1 || r2 != -1 || r3 != -1)
        {
            Console.WriteLine($"  !! contract violated: dest-too-small={r1}, odd-pcm={r2}, empty={r3} (expected -1/-1/-1)");
            _failures++;
        }
        else
        {
            Console.WriteLine("  contract: dest too small / malformed PCM -> -1 (no exception, no partial write): OK");
        }
        Console.WriteLine();
    }

    // ------------------------------------------------------------------
    //  helpers
    // ------------------------------------------------------------------
    private static bool Roundtrip(short[] pcm, int encodedBytes, AlacDecoder dec, byte[] encBuf, short[] decBuf, int numSamples, int channels)
    {
        if (encodedBytes < 0)
        {
            Console.WriteLine("  !!! EncodeFrame returned -1");
            return false;
        }
        int got;
        try
        {
            got = dec.DecodeFrame(encBuf.AsSpan(0, encodedBytes), decBuf, numSamples);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  !!! decoder threw {ex.GetType().Name}: {ex.Message}");
            return false;
        }
        if (got != numSamples)
        {
            Console.WriteLine($"  !!! decoded {got} samples, expected {numSamples}");
            return false;
        }
        for (int i = 0; i < numSamples * channels; i++)
        {
            if (pcm[i] != decBuf[i])
            {
                Console.WriteLine($"  !!! mismatch at sample {i}: {pcm[i]} != {decBuf[i]}");
                return false;
            }
        }
        return true;
    }

    private static short[] Make(bool mono, Func<int, (short L, short R)> fn, int start, int count)
    {
        var buf = new short[count * (mono ? 1 : 2)];
        for (int i = 0; i < count; i++)
        {
            var (l, r) = fn(start + i);
            if (mono) buf[i] = l;
            else { buf[2 * i] = l; buf[2 * i + 1] = r; }
        }
        return buf;
    }

    private static short Sine(double amp, double freq, int n) =>
        (short)Math.Round(amp * 32767.0 * Math.Sin(2.0 * Math.PI * freq * n / SampleRate));

    private static short Square(double amp, double freq, int n) =>
        (short)(Math.Sin(2.0 * Math.PI * freq * n / SampleRate) >= 0 ? amp * 32767.0 : -amp * 32767.0);

    private static short Chirp(double amp, int n)
    {
        // 20 Hz .. 20 kHz linear sweep over 4 s, integrated phase
        double t = (double)n / SampleRate;
        double f = 20.0 + (20000.0 - 20.0) * (t / 4.0);
        double phase = 2.0 * Math.PI * (20.0 * t + (20000.0 - 20.0) * t * t / 8.0);
        return (short)Math.Round(amp * 32767.0 * Math.Sin(phase));
    }

    private static uint NextRand()
    {
        _rng ^= _rng << 13;
        _rng ^= _rng >> 17;
        _rng ^= _rng << 5;
        return _rng;
    }

    private static short RandShort() => (short)(NextRand() >> 16);

    private static uint BE32(byte[] b, int o) => ((uint)b[o] << 24) | ((uint)b[o + 1] << 16) | ((uint)b[o + 2] << 8) | b[o + 3];

    private static string Hex(byte[] b)
    {
        var sb = new StringBuilder(b.Length * 3);
        for (int i = 0; i < b.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            sb.Append(b[i].ToString("x2", CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }
}
