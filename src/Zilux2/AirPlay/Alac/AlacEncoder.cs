// ============================================================================
//  AlacEncoder.cs — Pure-managed C# Apple Lossless (ALAC) encoder.
//
//  Port of Apple's open-source ALAC reference implementation:
//    https://github.com/macosforge/alac  (Apache License 2.0)
//    sources: codec/ALACEncoder.cpp, codec/ag_enc.c, codec/dp_enc.c,
//             codec/matrix_enc.c, codec/ALACBitUtilities.c, codec/aglib.h,
//             codec/dplib.h, codec/ALACAudioTypes.h
//
//  Copyright (c) 2011 Apple Inc. All rights reserved. Licensed under the
//  Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
//  This C# derivative keeps the original algorithm, constants and bitstream
//  format; it is NOT an Apple product and comes with no warranty.
//
//  Scope for Zilux2 / AirPlay (RAOP):
//    * 16-bit PCM only (AirPlay 1 RAOP transports 16-bit 44.1 kHz stereo),
//    * mono and stereo,
//    * one ALAC frame per RAOP packet (352 samples/channel by default).
// ============================================================================

using System;
using System.Numerics;

namespace Zilux2.AirPlay.Alac;

/// <summary>
/// Managed ALAC encoder. One <see cref="EncodeFrame"/> call produces one complete
/// ALAC frame (element tag + payload + ID_END + byte alignment), which maps 1:1 to
/// one RAOP audio packet payload.
/// </summary>
public sealed class AlacEncoder
{
    // ---- constants from aglib.h / dplib.h / ALACEncoder.cpp -----------------
    private const int QBSHIFT = 9;
    private const uint QB = 512;                 // 1 << QBSHIFT
    private const int PB0 = 40;
    private const int MB0 = 10;
    private const int KB0 = 14;
    private const int MMULSHIFT = 2;
    private const int MDENSHIFT = QBSHIFT - MMULSHIFT - 1;   // 6
    private const int MOFF = 1 << (MDENSHIFT - 2);           // 16
    private const int BITOFF = 24;
    private const int MAX_PREFIX_16 = 9;
    private const int MAX_DATATYPE_BITS_16 = 16;
    private const int MAX_PREFIX_32 = 9;
    private const int DENSHIFT_DEFAULT = 9;
    private const int AINIT = 38;
    private const int BINIT = -29;
    private const int CINIT = -2;
    private const int NUMCOEPAIRS = 16;
    private const int MAX_RUN_DEFAULT = 255;
    private const int KALAC_MAX_SEARCHES = 16;

    private const int kDefaultMixBits = 2;
    private const int kDefaultMixRes = 0;
    private const int kDefaultNumUV = 8;
    private const int kMinUV = 4;
    private const int kMaxUV = 8;
    private const int kMaxRes = 4;

    // The predictor/entropy search passes use numSamples/32 (convergence) and
    // numSamples/8 sub-blocks and require at least (numU+1) = 9 samples each,
    // so compressed frames need >= 288 samples. Shorter (tail) frames are
    // emitted as standards-legal "escape" (uncompressed) frames instead.
    private const int MinCompressedFrameSamples = 288;

    // ---- configuration ------------------------------------------------------
    private int _sampleRate = 44100;
    private int _channels = 2;
    private int _bitDepth = 16;
    private int _frameLength = 352;
    private int _pairCount = 1;
    private bool _initialized;

    // ---- pre-allocated scratch (no allocation inside EncodeFrame) -----------
    private int[] _mixU = Array.Empty<int>();
    private int[] _mixV = Array.Empty<int>();
    private int[] _predU = Array.Empty<int>();
    private int[] _predV = Array.Empty<int>();
    private short[][][] _coefsU = Array.Empty<short[][]>();   // [pair][search][NUMCOEPAIRS]
    private short[][][] _coefsV = Array.Empty<short[][]>();
    private int[] _lastMixRes = Array.Empty<int>();
    private byte[] _workBuf = Array.Empty<byte>();

    /// <summary>Configure the encoder. Must be called before <see cref="EncodeFrame"/>.</summary>
    /// <param name="sampleRate">PCM sample rate (Hz).</param>
    /// <param name="channels">1 (mono) or 2 (stereo).</param>
    /// <param name="bitDepth">Source bit depth; only 16 is supported.</param>
    /// <param name="frameLength">Samples per channel in one ALAC frame (RAOP uses 352).</param>
    public void Init(int sampleRate = 44100, int channels = 2, int bitDepth = 16, int frameLength = 352)
    {
        if (sampleRate < 8000 || sampleRate > 384000)
            throw new ArgumentOutOfRangeException(nameof(sampleRate), sampleRate, "sample rate out of range");
        if (channels < 1 || channels > 2)
            throw new NotSupportedException("ALAC encoder: only 1 or 2 channels are supported");
        if (bitDepth != 16)
            throw new NotSupportedException("ALAC encoder: only 16-bit PCM is supported");
        if (frameLength < 1 || frameLength > 4096)
            throw new ArgumentOutOfRangeException(nameof(frameLength), frameLength, "frame length out of range");

        _sampleRate = sampleRate;
        _channels = channels;
        _bitDepth = bitDepth;
        _frameLength = frameLength;
        _pairCount = 1;

        _mixU = new int[frameLength];
        _mixV = new int[frameLength];
        _predU = new int[frameLength];
        _predV = new int[frameLength];

        _coefsU = new short[_pairCount][][];
        _coefsV = new short[_pairCount][][];
        for (int p = 0; p < _pairCount; p++)
        {
            _coefsU[p] = new short[KALAC_MAX_SEARCHES][];
            _coefsV[p] = new short[KALAC_MAX_SEARCHES][];
            for (int s = 0; s < KALAC_MAX_SEARCHES; s++)
            {
                _coefsU[p][s] = new short[NUMCOEPAIRS];
                _coefsV[p][s] = new short[NUMCOEPAIRS];
                InitCoefs(_coefsU[p][s]);
                InitCoefs(_coefsV[p][s]);
            }
        }

        _lastMixRes = new int[_pairCount];
        for (int p = 0; p < _pairCount; p++) _lastMixRes[p] = kDefaultMixRes;

        _workBuf = new byte[MaxFrameBytes];
        _initialized = true;
        LastFrameWasEscape = false;
        LastFrameBytes = 0;
    }

    /// <summary>Upper bound (bytes) of any frame produced by this configuration.</summary>
    public int MaxFrameBytes => _frameLength * _channels * 2 + 16;

    public int SampleRate => _sampleRate;
    public int Channels => _channels;
    public int BitDepth => _bitDepth;
    public int FrameLength => _frameLength;

    /// <summary>True if the most recently encoded frame used the uncompressed escape path.</summary>
    public bool LastFrameWasEscape { get; private set; }

    /// <summary>Bytes written by the most recent <see cref="EncodeFrame"/> call.</summary>
    public int LastFrameBytes { get; private set; }

    /// <summary>
    /// Encode one ALAC frame from interleaved 16-bit PCM.
    /// </summary>
    /// <param name="pcmInterleaved">
    /// Interleaved PCM, <c>numSamples * channels</c> shorts. For RAOP this is
    /// 352 * 2 = 704 shorts (1408 bytes). Fewer samples are allowed for the
    /// final packet of a stream ("partial frame").
    /// </param>
    /// <param name="dest">Destination buffer; must be at least <see cref="MaxFrameBytes"/> bytes.</param>
    /// <returns>Number of bytes written.</returns>
    public int EncodeFrame(ReadOnlySpan<short> pcmInterleaved, Span<byte> dest)
    {
        if (!_initialized) throw new InvalidOperationException("AlacEncoder.Init() must be called first");
        if (pcmInterleaved.Length % _channels != 0)
            throw new ArgumentException("PCM span length must be a multiple of the channel count", nameof(pcmInterleaved));

        int numSamples = pcmInterleaved.Length / _channels;
        if (numSamples <= 0) throw new ArgumentException("empty PCM frame", nameof(pcmInterleaved));
        if (numSamples > _frameLength)
            throw new ArgumentException($"frame has {numSamples} samples, configured frameLength is {_frameLength}", nameof(pcmInterleaved));
        if (dest.Length < MaxFrameBytes)
            throw new ArgumentException($"destination must be at least {MaxFrameBytes} bytes", nameof(dest));

        LastFrameWasEscape = false;
        var w = new AlacBitWriter(dest);

        if (_channels == 2)
        {
            w.WriteBits(1, 3);          // ID_CPE
            w.WriteBits(0, 4);          // element instance tag
            EncodeStereo(ref w, pcmInterleaved, numSamples);
        }
        else
        {
            w.WriteBits(0, 3);          // ID_SCE
            w.WriteBits(0, 4);          // element instance tag
            EncodeMono(ref w, pcmInterleaved, numSamples);
        }

        w.WriteBits(7, 3);              // ID_END
        LastFrameBytes = w.Finish();
        return LastFrameBytes;
    }

    /// <summary>
    /// Build the ALAC "magic cookie" (ALACSpecificConfig, 24 bytes, big-endian).
    /// For stereo this is the complete cookie (a 'chan' channel-layout atom is
    /// only required for more than 2 channels, which this encoder does not support).
    /// </summary>
    /// <param name="maxFrameBytes">0 = unknown; pass <see cref="MaxFrameBytes"/> if a bound is desired.</param>
    /// <param name="avgBitRate">0 = unknown.</param>
    public byte[] GetMagicCookie(uint maxFrameBytes = 0, uint avgBitRate = 0)
    {
        if (!_initialized) throw new InvalidOperationException("AlacEncoder.Init() must be called first");
        var cookie = new byte[24];
        WriteBE32(cookie, 0, (uint)_frameLength);
        cookie[4] = 0;                       // compatibleVersion (must be 0)
        cookie[5] = (byte)_bitDepth;
        cookie[6] = PB0;                     // pb
        cookie[7] = MB0;                     // mb
        cookie[8] = KB0;                     // kb
        cookie[9] = (byte)_channels;
        cookie[10] = (byte)(MAX_RUN_DEFAULT >> 8);   // maxRun, big-endian
        cookie[11] = (byte)(MAX_RUN_DEFAULT & 0xFF);
        WriteBE32(cookie, 12, maxFrameBytes);
        WriteBE32(cookie, 16, avgBitRate);
        WriteBE32(cookie, 20, (uint)_sampleRate);
        return cookie;
    }

    // ========================================================================
    //  Stereo path (port of ALACEncoder::EncodeStereo, 16-bit branch)
    // ========================================================================
    private void EncodeStereo(ref AlacBitWriter w, ReadOnlySpan<short> input, int numSamples)
    {
        short[][] coefsU = _coefsU[0];
        short[][] coefsV = _coefsV[0];

        const int bytesShifted = 0;
        const int chanBits = 16 - 0 + 1;     // matrix coding uses one extra bit
        const int denShift = DENSHIFT_DEFAULT;
        const int mode = 0;
        const int pbFactor = 4;
        const int mixBits = kDefaultMixBits;

        bool partial = numSamples != _frameLength;
        int numU = kDefaultNumUV;
        int numV = kDefaultNumUV;

        var saved = w;
        bool doEscape = false;

        uint escapeBits = (uint)(numSamples * _bitDepth * 2 + (partial ? 32 : 0) + 2 * 8);

        if (numSamples < MinCompressedFrameSamples)
        {
            doEscape = true;
        }
        else
        {
            // ---- pass 1: choose mixRes (0..4) on a decimated block --------
            uint minBits1 = uint.MaxValue, minBits2 = uint.MaxValue;
            int bestRes = _lastMixRes[0];
            int n8 = numSamples / 8;

            for (int mixResC = 0; mixResC <= kMaxRes; mixResC++)
            {
                Mix16(input, 2, _mixU, _mixV, n8, mixBits, mixResC);
                PcBlock(_mixU, _predU, n8, coefsU[numU - 1], numU, chanBits, denShift);
                PcBlock(_mixV, _predV, n8, coefsV[numV - 1], numV, chanBits, denShift);

                var work = new AlacBitWriter(_workBuf);
                uint bits1 = DynComp(ref work, _predU, n8, chanBits);
                work = new AlacBitWriter(_workBuf);
                uint bits2 = DynComp(ref work, _predV, n8, chanBits);

                if (bits1 + bits2 < minBits1)
                {
                    minBits1 = bits1 + bits2;
                    bestRes = mixResC;
                }
            }

            _lastMixRes[0] = bestRes;
            Mix16(input, 2, _mixU, _mixV, numSamples, mixBits, bestRes);

            // ---- pass 2: choose numU / numV (4 or 8 taps) ------------------
            numU = numV = kMinUV;
            minBits1 = minBits2 = uint.MaxValue;
            int nSub = numSamples / 8;

            for (int numUV = kMinUV; numUV <= kMaxUV; numUV += 4)
            {
                int dilate = 32;
                for (int converge = 0; converge < 8; converge++)
                {
                    PcBlock(_mixU, _predU, numSamples / dilate, coefsU[numUV - 1], numUV, chanBits, denShift);
                    PcBlock(_mixV, _predV, numSamples / dilate, coefsV[numUV - 1], numUV, chanBits, denShift);
                }

                // Apple's reference scores dyn_comp over numSamples/8 samples after
                // converging on numSamples/32; we run one more predictor pass over
                // the numSamples/8 block so the scoring input is fully defined.
                PcBlock(_mixU, _predU, nSub, coefsU[numUV - 1], numUV, chanBits, denShift);
                PcBlock(_mixV, _predV, nSub, coefsV[numUV - 1], numUV, chanBits, denShift);

                var work = new AlacBitWriter(_workBuf);
                uint bits1 = DynComp(ref work, _predU, nSub, chanBits);
                uint score1 = bits1 * 8 + 16 * (uint)numUV;
                if (score1 < minBits1) { minBits1 = score1; numU = numUV; }

                work = new AlacBitWriter(_workBuf);
                uint bits2 = DynComp(ref work, _predV, nSub, chanBits);
                uint score2 = bits2 * 8 + 16 * (uint)numUV;
                if (score2 < minBits2) { minBits2 = score2; numV = numUV; }
            }

            uint minBits = minBits1 + minBits2 + 8u * 8u + (partial ? 32u : 0u);
            doEscape = minBits >= escapeBits;

            if (!doEscape)
            {
                // ---- write header + predictor coefficients ----------------
                w.WriteBits(0, 12);
                w.WriteBits((uint)(((partial ? 1 : 0) << 3) | (bytesShifted << 1)), 4);
                if (partial) w.WriteBits((uint)numSamples, 32);
                w.WriteBits((uint)mixBits, 8);
                w.WriteBits((byte)bestRes, 8);
                w.WriteBits((uint)((mode << 4) | denShift), 8);
                w.WriteBits((uint)((pbFactor << 5) | numU), 8);
                for (int i = 0; i < numU; i++) w.WriteBits((ushort)coefsU[numU - 1][i], 16);
                w.WriteBits((uint)((mode << 4) | denShift), 8);
                w.WriteBits((uint)((pbFactor << 5) | numV), 8);
                for (int i = 0; i < numV; i++) w.WriteBits((ushort)coefsV[numV - 1][i], 16);

                // ---- final predictor + entropy coding ----------------------
                PcBlock(_mixU, _predU, numSamples, coefsU[numU - 1], numU, chanBits, denShift);
                DynComp(ref w, _predU, numSamples, chanBits);
                PcBlock(_mixV, _predV, numSamples, coefsV[numV - 1], numV, chanBits, denShift);
                DynComp(ref w, _predV, numSamples, chanBits);

                if ((uint)(w.BitPosition - saved.BitPosition) >= escapeBits)
                    doEscape = true;
            }
        }

        if (doEscape)
        {
            w = saved;
            LastFrameWasEscape = true;
            EncodeStereoEscape(ref w, input, numSamples, partial);
        }
    }

    private static void EncodeStereoEscape(ref AlacBitWriter w, ReadOnlySpan<short> input, int numSamples, bool partial)
    {
        w.WriteBits(0, 12);
        w.WriteBits((uint)(((partial ? 1 : 0) << 3) | 1), 4);   // LSB = 1 -> not compressed
        if (partial) w.WriteBits((uint)numSamples, 32);
        for (int i = 0; i < numSamples; i++)
        {
            w.WriteBits((ushort)input[i * 2 + 0], 16);
            w.WriteBits((ushort)input[i * 2 + 1], 16);
        }
    }

    // ========================================================================
    //  Mono path (port of ALACEncoder::EncodeMono, 16-bit branch)
    // ========================================================================
    private void EncodeMono(ref AlacBitWriter w, ReadOnlySpan<short> input, int numSamples)
    {
        short[][] coefsU = _coefsU[0];

        const int bytesShifted = 0;
        const int chanBits = 16;
        const int denShift = DENSHIFT_DEFAULT;
        const int pbFactor = 4;

        bool partial = numSamples != _frameLength;
        var saved = w;
        bool doEscape = false;

        uint escapeBits = (uint)(numSamples * _bitDepth + (partial ? 32 : 0) + 2 * 8);

        if (numSamples < MinCompressedFrameSamples)
        {
            doEscape = true;
        }
        else
        {
            for (int i = 0; i < numSamples; i++) _mixU[i] = input[i];

            // ---- brute force over numU = 4, 8 -----------------------------
            uint minBits = uint.MaxValue;
            int bestU = kMinUV;
            int nSub = numSamples / 8;

            for (int numU = kMinUV; numU <= kMaxUV; numU += 4)
            {
                for (int converge = 0; converge < 7; converge++)
                    PcBlock(_mixU, _predU, numSamples / 32, coefsU[numU - 1], numU, chanBits, denShift);

                PcBlock(_mixU, _predU, nSub, coefsU[numU - 1], numU, chanBits, denShift);

                var work = new AlacBitWriter(_workBuf);
                uint bits = DynComp(ref work, _predU, nSub, chanBits);
                uint numBits = bits * 8 + 16 * (uint)numU;
                if (numBits < minBits) { minBits = numBits; bestU = numU; }
            }

            minBits += 4u * 8u + (partial ? 32u : 0u);
            doEscape = minBits >= escapeBits;

            if (!doEscape)
            {
                w.WriteBits(0, 12);
                w.WriteBits((uint)(((partial ? 1 : 0) << 3) | (bytesShifted << 1)), 4);
                if (partial) w.WriteBits((uint)numSamples, 32);
                w.WriteBits(0, 16);                     // mixBits = mixRes = 0
                w.WriteBits((uint)((0 << 4) | denShift), 8);
                w.WriteBits((uint)((pbFactor << 5) | bestU), 8);
                for (int i = 0; i < bestU; i++) w.WriteBits((ushort)coefsU[bestU - 1][i], 16);

                PcBlock(_mixU, _predU, numSamples, coefsU[bestU - 1], bestU, chanBits, denShift);
                DynComp(ref w, _predU, numSamples, chanBits);

                if ((uint)(w.BitPosition - saved.BitPosition) >= escapeBits)
                    doEscape = true;
            }
        }

        if (doEscape)
        {
            w = saved;
            LastFrameWasEscape = true;
            EncodeMonoEscape(ref w, input, numSamples, partial);
        }
    }

    private static void EncodeMonoEscape(ref AlacBitWriter w, ReadOnlySpan<short> input, int numSamples, bool partial)
    {
        w.WriteBits(0, 12);
        w.WriteBits((uint)(((partial ? 1 : 0) << 3) | 1), 4);
        if (partial) w.WriteBits((uint)numSamples, 32);
        for (int i = 0; i < numSamples; i++) w.WriteBits((ushort)input[i], 16);
    }

    // ========================================================================
    //  Matrix mixer (port of mix16 from matrix_enc.c)
    // ========================================================================
    //  u := (mixRes*L + (mod-mixRes)*R) >> mixBits ; v := L - R
    //  inverse (matrix_dec.c): L = u + v - ((mixRes*v) >> mixBits); R = L - v
    private static void Mix16(ReadOnlySpan<short> input, int stride, int[] u, int[] v, int numSamples, int mixBits, int mixRes)
    {
        if (mixRes != 0)
        {
            int mod = 1 << mixBits;
            int m2 = mod - mixRes;
            for (int j = 0, k = 0; j < numSamples; j++, k += stride)
            {
                int l = input[k];
                int r = input[k + 1];
                u[j] = (mixRes * l + m2 * r) >> mixBits;
                v[j] = l - r;
            }
        }
        else
        {
            for (int j = 0, k = 0; j < numSamples; j++, k += stride)
            {
                u[j] = input[k];
                v[j] = input[k + 1];
            }
        }
    }

    // ========================================================================
    //  Dynamic predictor (port of pc_block from dp_enc.c, generic branch)
    // ========================================================================
    private static void PcBlock(int[] input, int[] pc1, int num, short[] coefs, int numactive, int chanbits, int denshift)
    {
        int chanshift = 32 - chanbits;
        int denhalf = 1 << (denshift - 1);

        pc1[0] = input[0];
        if (numactive == 0)
        {
            if (num > 1 && !ReferenceEquals(input, pc1))
                Array.Copy(input, 1, pc1, 1, num - 1);
            return;
        }
        if (numactive == 31)
        {
            for (int j = 1; j < num; j++)
            {
                int del = input[j] - input[j - 1];
                pc1[j] = (del << chanshift) >> chanshift;
            }
            return;
        }

        for (int j = 1; j <= numactive; j++)
        {
            int del = input[j] - input[j - 1];
            pc1[j] = (del << chanshift) >> chanshift;
        }

        int lim = numactive + 1;
        for (int j = lim; j < num; j++)
        {
            int top = input[j - lim];
            int sum1 = 0;
            for (int k = 0; k < numactive; k++)
                sum1 -= coefs[k] * (top - input[j - 1 - k]);

            int del = input[j] - top - ((sum1 + denhalf) >> denshift);
            del = (del << chanshift) >> chanshift;
            pc1[j] = del;
            int del0 = del;
            int sg = SignOfInt(del);

            if (sg > 0)
            {
                for (int k = numactive - 1; k >= 0; k--)
                {
                    int dd = top - input[j - 1 - k];
                    int sgn = SignOfInt(dd);
                    coefs[k] = unchecked((short)(coefs[k] - sgn));
                    del0 -= (numactive - k) * ((sgn * dd) >> denshift);
                    if (del0 <= 0) break;
                }
            }
            else if (sg < 0)
            {
                for (int k = numactive - 1; k >= 0; k--)
                {
                    int dd = top - input[j - 1 - k];
                    int sgn = SignOfInt(dd);
                    coefs[k] = unchecked((short)(coefs[k] + sgn));
                    del0 -= (numactive - k) * ((-sgn * dd) >> denshift);
                    if (del0 >= 0) break;
                }
            }
        }
    }

    // ========================================================================
    //  Entropy coder (port of dyn_comp / dyn_code* / dyn_jam from ag_enc.c)
    // ========================================================================
    private static uint DynComp(ref AlacBitWriter w, int[] pc, int numSamples, int bitSize)
    {
        uint mb = MB0;
        uint pb = PB0;
        uint kb = KB0;
        uint wb = (1u << (int)kb) - 1;
        int zmode = 0;
        int c = 0;
        int inPtr = 0;
        int start = w.BitPosition;

        while (c < numSamples)
        {
            uint m = mb >> QBSHIFT;
            int k = Lg3a((int)m);
            if (k > (int)kb) k = (int)kb;
            m = (uint)((1 << k) - 1);

            int del = pc[inPtr++];
            uint n = unchecked((uint)((AbsFunc(del) << 1) - ((del >> 31) & 1) - zmode));

            if (DynCode32(maxbits: bitSize, m, (uint)k, n,
                          out int numBits, out uint value, out uint overflow, out int overflowBits))
            {
                w.WriteBits(value, numBits);
                w.WriteBits(overflow, overflowBits);
            }
            else
            {
                w.WriteBits(value, numBits);
            }

            c++;
            mb = unchecked(pb * (n + (uint)zmode) + mb - ((pb * mb) >> QBSHIFT));
            if (n > 0xffff) mb = 0xffff;
            zmode = 0;

            if (((mb << MMULSHIFT) < QB) && (c < numSamples))
            {
                zmode = 1;
                uint nz = 0;
                while (c < numSamples && pc[inPtr] == 0)
                {
                    inPtr++;
                    nz++;
                    c++;
                    if (nz >= 65535) { zmode = 0; break; }
                }

                int kz = BitOperations.LeadingZeroCount(mb) - BITOFF + (int)((mb + MOFF) >> MDENSHIFT);
                uint mz = (uint)((1 << kz) - 1) & wb;
                uint zvalue = DynCode16((int)mz, kz, (int)nz, out int zbits);
                w.WriteBits(zvalue, zbits);
                mb = 0;
            }
        }

        return (uint)(w.BitPosition - start);
    }

    private static uint DynCode16(int m, int k, int n, out int numBits)
    {
        uint div = (uint)n / (uint)m;
        uint value;
        if (div >= MAX_PREFIX_16)
        {
            numBits = MAX_PREFIX_16 + MAX_DATATYPE_BITS_16;
            value = (((1u << MAX_PREFIX_16) - 1) << MAX_DATATYPE_BITS_16) + (uint)n;
        }
        else
        {
            uint mod = (uint)n % (uint)m;
            uint de = mod == 0 ? 1u : 0u;
            int nb = (int)div + k + 1 - (int)de;
            uint v = (((1u << (int)div) - 1) << (nb - (int)div)) + mod + 1 - de;
            if (nb > MAX_PREFIX_16 + MAX_DATATYPE_BITS_16)
            {
                nb = MAX_PREFIX_16 + MAX_DATATYPE_BITS_16;
                v = (((1u << MAX_PREFIX_16) - 1) << MAX_DATATYPE_BITS_16) + (uint)n;
            }
            numBits = nb;
            value = v;
        }
        return value;
    }

    private static bool DynCode32(int maxbits, uint m, uint k, uint n,
                                  out int numBits, out uint value, out uint overflow, out int overflowBits)
    {
        uint div = n / m;
        if (div < MAX_PREFIX_32)
        {
            uint mod = n - m * div;
            uint de = mod == 0 ? 1u : 0u;
            int nb = (int)div + (int)k + 1 - (int)de;
            uint v = (((1u << (int)div) - 1) << (nb - (int)div)) + mod + 1 - de;
            if (nb <= 25)
            {
                numBits = nb;
                value = v;
                overflow = 0;
                overflowBits = 0;
                return false;
            }
        }

        numBits = MAX_PREFIX_32;
        value = (1u << MAX_PREFIX_32) - 1;
        overflow = n;
        overflowBits = maxbits;
        return true;
    }

    // ========================================================================
    //  small helpers
    // ========================================================================
    private static void InitCoefs(short[] coefs)
    {
        int den = 1 << DENSHIFT_DEFAULT;      // 512
        Array.Clear(coefs);
        coefs[0] = (short)((AINIT * den) >> 4);    // 1216
        coefs[1] = (short)((BINIT * den) >> 4);    // -928
        coefs[2] = (short)((CINIT * den) >> 4);    // -64
    }

    private static int Lg3a(int x) => 31 - BitOperations.LeadingZeroCount((uint)(x + 3));

    private static int SignOfInt(int i)
    {
        int negishift = (int)((uint)(-i) >> 31);
        return negishift | (i >> 31);
    }

    private static int AbsFunc(int a)
    {
        int isneg = a >> 31;
        int xorval = a ^ isneg;
        return xorval - isneg;
    }

    private static void WriteBE32(byte[] dst, int offset, uint value)
    {
        dst[offset + 0] = (byte)(value >> 24);
        dst[offset + 1] = (byte)(value >> 16);
        dst[offset + 2] = (byte)(value >> 8);
        dst[offset + 3] = (byte)value;
    }
}

/// <summary>
/// Minimal MSB-first bit writer writing a single ALAC frame into a caller buffer.
/// Mirrors BitBuffer / dyn_jam semantics of ALACBitUtilities.c and ag_enc.c.
/// </summary>
internal ref struct AlacBitWriter
{
    private readonly Span<byte> _dst;
    private int _bytePos;
    private int _bitPos;
    private byte _cur;

    public AlacBitWriter(Span<byte> dst)
    {
        _dst = dst;
        _bytePos = 0;
        _bitPos = 0;
        _cur = 0;
    }

    public int BitPosition => _bytePos * 8 + _bitPos;

    /// <summary>Write the low <paramref name="numBits"/> (1..32) bits of <paramref name="value"/>, MSB first.</summary>
    public void WriteBits(ulong value, int numBits)
    {
        while (numBits > 0)
        {
            int avail = 8 - _bitPos;
            int take = numBits < avail ? numBits : avail;
            int shift = numBits - take;
            ulong bits = (value >> shift) & ((1UL << take) - 1);
            _cur |= (byte)(bits << (avail - take));
            numBits -= take;
            _bitPos += take;
            if (_bitPos == 8)
            {
                _dst[_bytePos++] = _cur;
                _cur = 0;
                _bitPos = 0;
            }
        }
    }

    /// <summary>Flush the partial byte (zero padded) and return the total frame size in bytes.</summary>
    public int Finish()
    {
        if (_bitPos > 0)
        {
            _dst[_bytePos++] = _cur;
            _cur = 0;
            _bitPos = 0;
        }
        return _bytePos;
    }
}
