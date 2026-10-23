// ============================================================================
//  AlacDecoder.cs — Pure-managed C# Apple Lossless (ALAC) decoder.
//
//  Port of Apple's open-source ALAC reference implementation:
//    https://github.com/macosforge/alac  (Apache License 2.0)
//    sources: codec/ALACDecoder.cpp, codec/ag_dec.c, codec/dp_dec.c,
//             codec/matrix_dec.c, codec/ALACBitUtilities.c
//  Copyright (c) 2011 Apple Inc. Licensed under the Apache License, Version 2.0.
//
//  PURPOSE IN ZILUX2: verification only. The encoder ships in the AirPlay
//  pipeline; this decoder exists so the self-check program can prove bit-exact
//  lossless round-trips without any native library (no ffmpeg required).
//  It deliberately covers only the subset the encoder can emit: 16-bit PCM,
//  1–2 channels, predictor mode 0, no "bytesShifted" (20/24/32-bit) data.
//
//  Companion file: AlacBitReader.cs (MSB-first bit reader).
// ============================================================================

using System;
using System.IO;
using System.Numerics;

namespace Zilux2.AirPlay.Alac;

/// <summary>ALAC stream configuration, as carried by the 24-byte magic cookie.</summary>
public sealed class AlacConfig
{
    public int FrameLength { get; set; }
    public byte CompatibleVersion { get; set; }
    public int BitDepth { get; set; }
    public int Pb { get; set; }
    public int Mb { get; set; }
    public int Kb { get; set; }
    public int NumChannels { get; set; }
    public int MaxRun { get; set; }
    public long MaxFrameBytes { get; set; }
    public long AvgBitRate { get; set; }
    public int SampleRate { get; set; }
}

/// <summary>
/// Managed ALAC decoder used by the verification harness. Decodes the frames
/// produced by <see cref="AlacEncoder"/> and, within the 16-bit / ≤2-channel
/// subset, standard Apple ALAC frames.
/// </summary>
public sealed class AlacDecoder
{
    // constants from aglib.h / dp_dec.c
    private const int QBSHIFT = 9;
    private const int MMULSHIFT = 2;
    private const int MDENSHIFT = QBSHIFT - MMULSHIFT - 1;   // 6
    private const int MOFF = 1 << (MDENSHIFT - 2);           // 16
    private const int BITOFF = 24;
    private const int MAX_PREFIX_16 = 9;
    private const int MAX_DATATYPE_BITS_16 = 16;
    private const int MAX_PREFIX_32 = 9;
    private const int NUMCOEPAIRS = 16;

    private bool _initialized;
    private int[] _predictor = Array.Empty<int>();
    private int[] _mixU = Array.Empty<int>();
    private int[] _mixV = Array.Empty<int>();
    private readonly short[] _coefsU = new short[NUMCOEPAIRS];
    private readonly short[] _coefsV = new short[NUMCOEPAIRS];

    /// <summary>Stream configuration (valid after Init).</summary>
    public AlacConfig Config { get; } = new();

    /// <summary>Initialise from a 24-byte ALACSpecificConfig cookie (a trailing 'chan' atom is ignored for stereo).</summary>
    public void Init(ReadOnlySpan<byte> magicCookie)
    {
        if (magicCookie.Length < 24)
            throw new ArgumentException("ALAC magic cookie must be at least 24 bytes", nameof(magicCookie));

        Config.FrameLength = (int)ReadBE32(magicCookie, 0);
        Config.CompatibleVersion = magicCookie[4];
        Config.BitDepth = magicCookie[5];
        Config.Pb = magicCookie[6];
        Config.Mb = magicCookie[7];
        Config.Kb = magicCookie[8];
        Config.NumChannels = magicCookie[9];
        Config.MaxRun = ReadBE16(magicCookie, 10);
        Config.MaxFrameBytes = ReadBE32(magicCookie, 12);
        Config.AvgBitRate = ReadBE32(magicCookie, 16);
        Config.SampleRate = (int)ReadBE32(magicCookie, 20);
        ValidateConfig();
    }

    /// <summary>Initialise without a cookie (same defaults the encoder uses).</summary>
    public void Init(int sampleRate = 44100, int channels = 2, int bitDepth = 16, int frameLength = 352)
    {
        Config.FrameLength = frameLength;
        Config.CompatibleVersion = 0;
        Config.BitDepth = bitDepth;
        Config.Pb = 40;
        Config.Mb = 10;
        Config.Kb = 14;
        Config.NumChannels = channels;
        Config.MaxRun = 255;
        Config.MaxFrameBytes = 0;
        Config.AvgBitRate = 0;
        Config.SampleRate = sampleRate;
        ValidateConfig();
    }

    private void ValidateConfig()
    {
        if (Config.NumChannels < 1 || Config.NumChannels > 2)
            throw new NotSupportedException($"ALAC decoder: {Config.NumChannels} channels not supported (1–2 only)");
        if (Config.BitDepth != 16)
            throw new NotSupportedException($"ALAC decoder: {Config.BitDepth}-bit not supported (16-bit only)");
        if (Config.FrameLength < 1 || Config.FrameLength > 65536)
            throw new NotSupportedException($"ALAC decoder: frame length {Config.FrameLength} out of range");
        // NOTE: pb (40) / mb (10) / kb (14) are the *base* entropy parameters of
        // ALACSpecificConfig, not bit-widths; only sanity-check them here.
        if (Config.Pb < 1 || Config.Mb < 1 || Config.Kb < 1 || Config.MaxRun < 1)
            throw new NotSupportedException("ALAC decoder: invalid entropy parameters in cookie");
        _predictor = new int[Config.FrameLength];
        _mixU = new int[Config.FrameLength];
        _mixV = new int[Config.FrameLength];
        _initialized = true;
    }

    /// <summary>
    /// Decode one complete ALAC frame (the bytes returned by <see cref="AlacEncoder.EncodeFrame"/>).
    /// </summary>
    /// <param name="frame">Encoded frame.</param>
    /// <param name="pcmOut">Interleaved output; must hold at least <c>numSamplesHint * NumChannels</c> shorts.</param>
    /// <param name="numSamplesHint">Samples per channel carried in the frame (352 for RAOP; the partial-frame header overrides it).</param>
    /// <returns>Decoded samples per channel.</returns>
    public int DecodeFrame(ReadOnlySpan<byte> frame, Span<short> pcmOut, int numSamplesHint)
    {
        if (!_initialized) throw new InvalidOperationException("AlacDecoder.Init() must be called first");
        if (numSamplesHint < 1 || numSamplesHint > Config.FrameLength)
            throw new ArgumentOutOfRangeException(nameof(numSamplesHint));
        int numChannels = Config.NumChannels;
        if (pcmOut.Length < numSamplesHint * numChannels)
            throw new ArgumentException("output span too small", nameof(pcmOut));

        var br = new AlacBitReader(frame);
        int numSamples = numSamplesHint;
        int channelIndex = 0;

        while (true)
        {
            if (br.BitsRemaining < 3)
                throw new InvalidDataException("truncated ALAC frame: no element tag");
            int tag = (int)br.Read(3);

            if (tag == 7) // ID_END
            {
                br.ByteAlign();
                break;
            }

            switch (tag)
            {
                case 1: // ID_CPE
                    br.Read(4);                         // element instance tag
                    if (channelIndex + 2 > numChannels)
                        throw new InvalidDataException("ALAC: stereo element exceeds channel count");
                    DecodeStereo(ref br, ref numSamples, channelIndex, pcmOut);
                    channelIndex += 2;
                    break;

                case 0: // ID_SCE
                case 3: // ID_LFE
                    br.Read(4);
                    if (channelIndex + 1 > numChannels)
                        throw new InvalidDataException("ALAC: mono element exceeds channel count");
                    DecodeMono(ref br, ref numSamples, channelIndex, pcmOut);
                    channelIndex += 1;
                    break;

                default:
                    throw new NotSupportedException($"ALAC element tag {tag} not supported");
            }

            // Apple's decoder stops once every requested channel has been decoded.
            if (channelIndex >= numChannels) break;
        }

        // zero-fill channels the bitstream did not provide (matches ALACDecoder.cpp)
        for (; channelIndex < numChannels; channelIndex++)
            for (int i = 0; i < numSamples; i++)
                pcmOut[i * numChannels + channelIndex] = 0;

        return numSamples;
    }

    // ------------------------------------------------------------------
    //  element header: 12 reserved bits, 4 flag bits, optional 32-bit length
    // ------------------------------------------------------------------
    private bool ReadElementHeader(ref AlacBitReader br, ref int numSamples, out int bytesShifted)
    {
        if (br.Read(12) != 0)
            throw new InvalidDataException("ALAC: reserved header bits are not zero");
        uint headerByte = br.Read(4);
        bool partial = (headerByte & 0x8u) != 0;
        bytesShifted = (int)((headerByte >> 1) & 0x3u);
        if (bytesShifted == 3)
            throw new InvalidDataException("ALAC: invalid bytesShifted value 3");
        bool escape = (headerByte & 0x1u) != 0;

        if (partial)
            numSamples = (int)((br.Read(16) << 16) | br.Read(16));

        if (numSamples < 1 || numSamples > Config.FrameLength)
            throw new InvalidDataException($"ALAC: invalid frame length {numSamples}");
        return escape;
    }

    // ------------------------------------------------------------------
    //  mono element
    // ------------------------------------------------------------------
    private void DecodeMono(ref AlacBitReader br, ref int numSamples, int channelIndex, Span<short> pcmOut)
    {
        int numChannels = Config.NumChannels;
        bool escape = ReadElementHeader(ref br, ref numSamples, out int bytesShifted);

        if (escape)
        {
            int chanBits = Config.BitDepth;      // 16
            int shift = 32 - chanBits;
            for (int i = 0; i < numSamples; i++)
            {
                int val = (int)br.Read(chanBits);
                _mixU[i] = (val << shift) >> shift;   // sign-extend
            }
        }
        else
        {
            if (bytesShifted != 0)
                throw new NotSupportedException("ALAC decoder: bytesShifted streams (20/24/32-bit) not supported");

            int mixBits = (int)br.Read(8);        // mono: mixBits/mixRes are 0, but present
            int mixRes = (int)(sbyte)br.Read(8);
            _ = mixBits; _ = mixRes;

            int hdr = (int)br.Read(8);            // modeU (4 bits) | denShiftU (4 bits)
            int modeU = hdr >> 4;
            int denShiftU = hdr & 0xF;
            hdr = (int)br.Read(8);                // pbFactorU (3 bits) | numU (5 bits)
            int pbFactorU = hdr >> 5;
            int numU = hdr & 0x1F;
            for (int i = 0; i < numU; i++) _coefsU[i] = (short)(int)br.Read(16);

            if (modeU != 0)
                throw new NotSupportedException("ALAC decoder: non-zero predictor mode not supported (Apple encoder emits mode 0)");

            DynDecomp(ref br, _predictor, numSamples, chanBits: 16,
                      mb0: (uint)Config.Mb, pb: (uint)(Config.Pb * pbFactorU / 4), kb: (uint)Config.Kb);

            UnpcBlock(_predictor, _mixU, numSamples, _coefsU, numU, 16, denShiftU);
        }

        for (int i = 0; i < numSamples; i++)
            pcmOut[i * numChannels + channelIndex] = unchecked((short)_mixU[i]);
    }

    // ------------------------------------------------------------------
    //  stereo element
    // ------------------------------------------------------------------
    private void DecodeStereo(ref AlacBitReader br, ref int numSamples, int channelIndex, Span<short> pcmOut)
    {
        int numChannels = Config.NumChannels;
        bool escape = ReadElementHeader(ref br, ref numSamples, out int bytesShifted);

        if (escape)
        {
            int bits = Config.BitDepth;          // 16
            int shift = 32 - bits;
            for (int i = 0; i < numSamples; i++)
            {
                int u = (int)br.Read(bits); _mixU[i] = (u << shift) >> shift;
                int v = (int)br.Read(bits); _mixV[i] = (v << shift) >> shift;
            }
            Unmix16(_mixU, _mixV, pcmOut, channelIndex, numSamples, 0, 0, numChannels);
            return;
        }

        if (bytesShifted != 0)
            throw new NotSupportedException("ALAC decoder: bytesShifted streams (20/24/32-bit) not supported");
        int chanBits = Config.BitDepth - bytesShifted * 8 + 1;   // 17 for 16-bit stereo

        int mixBits = (int)br.Read(8);
        int mixRes = (int)(sbyte)br.Read(8);

        int hdr = (int)br.Read(8);                // modeU | denShiftU
        int modeU = hdr >> 4;
        int denShiftU = hdr & 0xF;
        hdr = (int)br.Read(8);                    // pbFactorU | numU
        int pbFactorU = hdr >> 5;
        int numU = hdr & 0x1F;
        for (int i = 0; i < numU; i++) _coefsU[i] = (short)(int)br.Read(16);

        hdr = (int)br.Read(8);                    // modeV | denShiftV
        int modeV = hdr >> 4;
        int denShiftV = hdr & 0xF;
        hdr = (int)br.Read(8);                    // pbFactorV | numV
        int pbFactorV = hdr >> 5;
        int numV = hdr & 0x1F;
        for (int i = 0; i < numV; i++) _coefsV[i] = (short)(int)br.Read(16);

        if (modeU != 0 || modeV != 0)
            throw new NotSupportedException("ALAC decoder: non-zero predictor mode not supported (Apple encoder emits mode 0)");

        DynDecomp(ref br, _predictor, numSamples, chanBits,
                  mb0: (uint)Config.Mb, pb: (uint)(Config.Pb * pbFactorU / 4), kb: (uint)Config.Kb);
        UnpcBlock(_predictor, _mixU, numSamples, _coefsU, numU, chanBits, denShiftU);

        DynDecomp(ref br, _predictor, numSamples, chanBits,
                  mb0: (uint)Config.Mb, pb: (uint)(Config.Pb * pbFactorV / 4), kb: (uint)Config.Kb);
        UnpcBlock(_predictor, _mixV, numSamples, _coefsV, numV, chanBits, denShiftV);

        Unmix16(_mixU, _mixV, pcmOut, channelIndex, numSamples, mixBits, mixRes, numChannels);
    }

    // ------------------------------------------------------------------
    //  matrix decoder (port of unmix16 from matrix_dec.c)
    // ------------------------------------------------------------------
    private static void Unmix16(int[] u, int[] v, Span<short> pcmOut, int channelIndex,
                                int numSamples, int mixBits, int mixRes, int numChannels)
    {
        if (mixRes != 0)
        {
            for (int j = 0; j < numSamples; j++)
            {
                int l = u[j] + v[j] - ((mixRes * v[j]) >> mixBits);
                int r = l - v[j];
                int o = j * numChannels + channelIndex;
                pcmOut[o] = unchecked((short)l);
                pcmOut[o + 1] = unchecked((short)r);
            }
        }
        else
        {
            for (int j = 0; j < numSamples; j++)
            {
                int o = j * numChannels + channelIndex;
                pcmOut[o] = unchecked((short)u[j]);
                pcmOut[o + 1] = unchecked((short)v[j]);
            }
        }
    }

    // ------------------------------------------------------------------
    //  dynamic predictor inverse (port of unpc_block from dp_dec.c, generic form)
    // ------------------------------------------------------------------
    private static void UnpcBlock(int[] pc1, int[] output, int num, short[] coefs, int numactive, int chanbits, int denshift)
    {
        int chanshift = 32 - chanbits;
        int denhalf = 1 << (denshift - 1);

        output[0] = pc1[0];

        if (numactive == 0)
        {
            if (num > 1 && !ReferenceEquals(pc1, output))
                Array.Copy(pc1, 1, output, 1, num - 1);
            return;
        }

        if (numactive == 31)
        {
            // special "numActive == 31" mode: first-order difference
            int prev = output[0];
            for (int j = 1; j < num; j++)
            {
                int del = pc1[j] + prev;
                del = (del << chanshift) >> chanshift;
                output[j] = del;
                prev = del;
            }
            return;
        }

        for (int j = 1; j <= numactive; j++)
        {
            int del = pc1[j] + output[j - 1];
            output[j] = (del << chanshift) >> chanshift;
        }

        int lim = numactive + 1;
        for (int j = lim; j < num; j++)
        {
            int top = output[j - lim];

            int sum1 = 0;
            for (int k = 0; k < numactive; k++)
                sum1 += coefs[k] * (output[j - 1 - k] - top);

            int del = pc1[j] + top + ((sum1 + denhalf) >> denshift);
            del = (del << chanshift) >> chanshift;
            output[j] = del;

            int del0 = pc1[j];
            int sg = SignOfInt(del0);
            if (sg > 0)
            {
                for (int k = numactive - 1; k >= 0; k--)
                {
                    int dd = top - output[j - 1 - k];
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
                    int dd = top - output[j - 1 - k];
                    int sgn = SignOfInt(dd);
                    coefs[k] = unchecked((short)(coefs[k] + sgn));
                    del0 -= (numactive - k) * ((-sgn * dd) >> denshift);
                    if (del0 >= 0) break;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    //  entropy decoder (port of dyn_decomp from ag_dec.c)
    // ------------------------------------------------------------------
    private static void DynDecomp(ref AlacBitReader br, int[] predictor, int numSamples, int chanBits, uint mb0, uint pb, uint kb)
    {
        uint wb = (uint)((1 << (int)kb) - 1);
        uint mb = mb0;
        int zmode = 0;
        int c = 0;

        while (c < numSamples)
        {
            uint m = mb >> QBSHIFT;
            int k = Lg3a((int)m);
            if (k > (int)kb) k = (int)kb;
            m = (uint)((1 << k) - 1);

            uint n = DynGet32Bit(ref br, m, k, chanBits);
            uint ndecode = n + (uint)zmode;
            int multiplier = (int)(-(ndecode & 1u)) | 1;
            int del = (int)((ndecode + 1) >> 1) * multiplier;
            predictor[c++] = del;

            mb = unchecked(pb * (n + (uint)zmode) + mb - ((pb * mb) >> QBSHIFT));
            if (n > 0xffff) mb = 0xffff;
            zmode = 0;

            if (((mb << MMULSHIFT) < 512u) && (c < numSamples))
            {
                zmode = 1;
                int kz = BitOperations.LeadingZeroCount(mb) - BITOFF + (int)((mb + MOFF) >> MDENSHIFT);
                uint mz = (uint)((1 << kz) - 1) & wb;
                int nz = DynGet(ref br, mz, kz);
                if (nz < 0 || c + nz > numSamples)
                    throw new InvalidDataException("ALAC: zero-run exceeds frame");
                for (int i = 0; i < nz; i++) predictor[c++] = 0;
                if (nz >= 65535) zmode = 0;
                mb = 0;
            }
        }
    }

    private static uint DynGet32Bit(ref AlacBitReader br, uint m, int k, int maxbits)
    {
        int p = br.BitPosition;
        uint w32 = br.Peek(p, 32);
        int pre = BitOperations.LeadingZeroCount(~w32);
        uint result;

        if (pre >= MAX_PREFIX_32)
        {
            // escaped raw sample: 9 one-bits then maxbits raw bits
            result = br.Peek(p + MAX_PREFIX_32, maxbits);
            p += MAX_PREFIX_32 + maxbits;
        }
        else
        {
            result = (uint)pre * m;
            if (k != 1)
            {
                uint v = br.Peek(p + pre + 1, k);
                p += pre + 1 + k;
                if (v >= 2) result += v - 1;
                else p -= 1;                      // v == 0 or 1: one fewer bit
            }
            else
            {
                p += pre + 1;
            }
        }

        br.SetPosition(p);
        return result;
    }

    private static int DynGet(ref AlacBitReader br, uint m, int k)
    {
        int p = br.BitPosition;
        uint w32 = br.Peek(p, 32);
        int pre = BitOperations.LeadingZeroCount(~w32);
        int result;

        if (pre >= MAX_PREFIX_16)
        {
            p += MAX_PREFIX_16;
            result = (int)br.Peek(p, MAX_DATATYPE_BITS_16);
            p += MAX_DATATYPE_BITS_16;
        }
        else
        {
            p += pre + 1;
            uint v = br.Peek(p, k);
            p += k;
            result = (int)((uint)pre * m) + (int)v - 1;
            if (v < 2)
            {
                result -= (int)(v - 1);
                p -= 1;
            }
        }

        br.SetPosition(p);
        return result;
    }

    // ------------------------------------------------------------------
    //  helpers
    // ------------------------------------------------------------------
    private static int Lg3a(int x) => 31 - BitOperations.LeadingZeroCount((uint)(x + 3));

    private static int SignOfInt(int i)
    {
        int negishift = (int)((uint)(-i) >> 31);
        return negishift | (i >> 31);
    }

    private static uint ReadBE32(ReadOnlySpan<byte> b, int o) =>
        ((uint)b[o] << 24) | ((uint)b[o + 1] << 16) | ((uint)b[o + 2] << 8) | b[o + 3];

    private static int ReadBE16(ReadOnlySpan<byte> b, int o) => (b[o] << 8) | b[o + 1];
}

// ============================================================================
//  AlacBitReader — MSB-first bit reader over one complete ALAC frame.
//  Mirrors BitBuffer / BitBufferReadSmall / BitBufferRead from Apple's
//  ALACBitUtilities.c (Apple open-source ALAC reference, Apache-2.0).
//  Bits past the end of the frame read as zero, which is what Apple's decoder
//  effectively sees because it works on a zero-padded buffer.
//  Kept in this same file so that copying AlacDecoder.cs alone into the app is
//  sufficient (verification-only: the product encoder uses AlacBitWriter).
// ============================================================================
/// <summary>Minimal MSB-first bit reader over one complete ALAC frame.</summary>
public ref struct AlacBitReader
{
    private readonly ReadOnlySpan<byte> _src;
    private int _bitPos;

    public AlacBitReader(ReadOnlySpan<byte> src)
    {
        _src = src;
        _bitPos = 0;
    }

    /// <summary>Current absolute bit position.</summary>
    public int BitPosition => _bitPos;

    /// <summary>Bits left in the frame data (negative once over-read, as with Apple's reader).</summary>
    public int BitsRemaining => _src.Length * 8 - _bitPos;

    /// <summary>Seek to an absolute bit position.</summary>
    public void SetPosition(int bitPosition) => _bitPos = bitPosition;

    /// <summary>Peek up to 32 bits at an absolute bit position without consuming; past-the-end reads 0.</summary>
    public uint Peek(int position, int numBits)
    {
        uint v = 0;
        int lenBits = _src.Length * 8;
        for (int i = 0; i < numBits; i++)
        {
            int p = position + i;
            uint bit = p >= 0 && p < lenBits ? (uint)((_src[p >> 3] >> (7 - (p & 7))) & 1) : 0u;
            v = (v << 1) | bit;
        }
        return v;
    }

    /// <summary>Read up to 32 bits MSB-first and advance the cursor.</summary>
    public uint Read(int numBits)
    {
        uint v = Peek(_bitPos, numBits);
        _bitPos += numBits;
        return v;
    }

    /// <summary>Round the cursor up to the next byte boundary (BitBufferByteAlign).</summary>
    public void ByteAlign() => _bitPos = (_bitPos + 7) & ~7;
}
