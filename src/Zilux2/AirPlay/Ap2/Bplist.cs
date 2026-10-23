using System.Buffers.Binary;
using System.Globalization;
using System.IO;
using System.Text;

namespace Zilux2.AirPlay.Ap2;

/// <summary>
/// Minimal Apple binary property list (bplist00) codec: just the subset AirPlay 2 needs for
/// <c>SETUP</c> and <c>/feedback</c> — dictionary, array, data, integer, real, boolean and string.
/// No NuGet dependency (the project deliberately avoids third-party parsers). The encoder emits
/// the canonical layout: "bplist00", the object table, the offset table and the 32-byte trailer.
/// </summary>
internal static class Bplist
{
    private const string Magic = "bplist00";

    /// <summary>
    /// Encodes a tree made of <see cref="Dictionary{TKey,TValue}"/> (string keys),
    /// <see cref="object"/> arrays, <c>byte[]</c>, <see cref="string"/>, integral numbers,
    /// <see cref="bool"/>, <see cref="double"/> and <c>null</c>.
    /// </summary>
    public static byte[] Encode(object? value)
    {
        var nodes = new List<Node>();
        var rootId = Collect(value, nodes);

        var objectRefSize = ByteSize(nodes.Count);
        using var output = new MemoryStream(256);
        WriteAscii(output, Magic);

        var offsets = new long[nodes.Count];
        for (var i = 0; i < nodes.Count; i++)
        {
            offsets[i] = output.Position;
            WriteNode(output, nodes[i], nodes, objectRefSize);
        }

        var offsetTableOffset = output.Position;
        var offsetIntSize = ByteSize((ulong)offsetTableOffset);
        foreach (var offset in offsets)
        {
            WriteBigEndian(output, (ulong)offset, offsetIntSize);
        }

        // Trailer: 6 reserved bytes, offset int size, object ref size, object count, top object, offset table offset.
        for (var i = 0; i < 6; i++)
        {
            output.WriteByte(0);
        }

        output.WriteByte((byte)offsetIntSize);
        output.WriteByte((byte)objectRefSize);
        WriteBigEndian(output, (ulong)nodes.Count, 8);
        WriteBigEndian(output, (ulong)rootId, 8);
        WriteBigEndian(output, (ulong)offsetTableOffset, 8);
        return output.ToArray();
    }

    /// <summary>
    /// Decodes a bplist00 document. Dictionaries become <see cref="Dictionary{TKey,TValue}"/>
    /// (string keys), arrays become <c>object?[]</c>, data becomes <c>byte[]</c>, integers become
    /// <c>long</c>, reals become <c>double</c>.
    /// </summary>
    public static object? Decode(ReadOnlySpan<byte> data)
    {
        if (data.Length < Magic.Length + 32 || !data[..Magic.Length].SequenceEqual(Encoding.ASCII.GetBytes(Magic)))
        {
            throw new InvalidDataException("Not a bplist00 document.");
        }

        var trailer = data[^32..];
        var offsetIntSize = trailer[6];
        var objectRefSize = trailer[7];
        var numObjects = (int)BinaryPrimitives.ReadUInt64BigEndian(trailer[8..16]);
        var topObject = (int)BinaryPrimitives.ReadUInt64BigEndian(trailer[16..24]);
        var offsetTableOffset = (int)BinaryPrimitives.ReadUInt64BigEndian(trailer[24..32]);
        if (offsetIntSize is 0 or > 8 || objectRefSize is 0 or > 8 || numObjects <= 0)
        {
            throw new InvalidDataException("Corrupt bplist00 trailer.");
        }

        if ((long)offsetTableOffset + ((long)numObjects * offsetIntSize) > data.Length)
        {
            throw new InvalidDataException("Corrupt bplist00 offset table.");
        }

        var offsets = new int[numObjects];
        for (var i = 0; i < numObjects; i++)
        {
            offsets[i] = (int)ReadBigEndian(data, offsetTableOffset + (i * offsetIntSize), offsetIntSize);
        }

        return ParseObject(data, offsets, topObject, objectRefSize);
    }

    // ---------------------------------------------------------------- encoder

    private sealed class Node
    {
        public object? Value { get; init; }

        public List<KeyValuePair<int, int>>? Dictionary { get; init; }

        public List<int>? Array { get; init; }
    }

    private static int Collect(object? value, List<Node> nodes)
    {
        var id = nodes.Count;
        switch (value)
        {
            case Dictionary<string, object?> dictionary:
            {
                var node = new Node { Value = null, Dictionary = [] };
                nodes.Add(node);
                foreach (var (key, child) in dictionary)
                {
                    // bplist dictionaries reference their keys by object id, so the key strings have
                    // to live in the object table like any other value.
                    var keyId = Collect(key, nodes);
                    node.Dictionary!.Add(new KeyValuePair<int, int>(keyId, Collect(child, nodes)));
                }

                return id;
            }

            case object?[] array:
            {
                var node = new Node { Value = null, Array = [] };
                nodes.Add(node);
                foreach (var child in array)
                {
                    node.Array!.Add(Collect(child, nodes));
                }

                return id;
            }

            default:
                nodes.Add(new Node { Value = value });
                return id;
        }
    }

    private static void WriteNode(MemoryStream output, Node node, List<Node> nodes, int objectRefSize)
    {
        if (node.Dictionary is { } dictionary)
        {
            WriteContainerHeader(output, 0xD0, dictionary.Count);
            foreach (var (keyId, _) in dictionary)
            {
                WriteObjectRef(output, keyId, objectRefSize);
            }

            foreach (var (_, childId) in dictionary)
            {
                WriteObjectRef(output, childId, objectRefSize);
            }

            return;
        }

        if (node.Array is { } array)
        {
            WriteContainerHeader(output, 0xA0, array.Count);
            foreach (var childId in array)
            {
                WriteObjectRef(output, childId, objectRefSize);
            }

            return;
        }

        switch (node.Value)
        {
            case null:
                output.WriteByte(0x00);
                break;
            case bool flag:
                output.WriteByte(flag ? (byte)0x09 : (byte)0x08);
                break;
            case byte[] data:
                WriteLength(output, 0x40, 0x4F, data.Length);
                output.Write(data, 0, data.Length);
                break;
            case string text:
                WriteString(output, text);
                break;
            case double number:
                output.WriteByte(0x23);
                WriteBigEndian(output, (ulong)BitConverter.DoubleToInt64Bits(number), 8);
                break;
            case sbyte or byte or short or ushort or int or uint or long or ulong:
                WriteInteger(output, Convert.ToInt64(node.Value, CultureInfo.InvariantCulture));
                break;
            default:
                throw new NotSupportedException($"bplist: unsupported value type '{node.Value.GetType().Name}'.");
        }
    }

    private static int FindStringNode(List<Node> nodes, string text)
    {
        // Keys are added through Collect as plain values; locate the node whose value is this exact
        // string instance (the dictionary keys were boxed once and are stable within the graph).
        for (var i = 0; i < nodes.Count; i++)
        {
            if (nodes[i].Value is string candidate && ReferenceEquals(candidate, text))
            {
                return i;
            }
        }

        throw new InvalidOperationException($"bplist: key '{text}' was not collected.");
    }

    private static void WriteContainerHeader(MemoryStream output, int markerBase, int count)
    {
        if (count < 15)
        {
            output.WriteByte((byte)(markerBase | count));
            return;
        }

        output.WriteByte((byte)(markerBase | 0x0F));
        WriteInteger(output, count);
    }

    private static void WriteLength(MemoryStream output, int markerBaseSmall, int markerBaseLong, int length)
    {
        if (length < 15)
        {
            output.WriteByte((byte)(markerBaseSmall | length));
            return;
        }

        output.WriteByte((byte)markerBaseLong);
        WriteInteger(output, length);
    }

    private static void WriteString(MemoryStream output, string text)
    {
        var isAscii = text.All(ch => ch < 0x80);
        if (isAscii)
        {
            WriteLength(output, 0x50, 0x5F, text.Length);
            foreach (var ch in text)
            {
                output.WriteByte((byte)ch);
            }

            return;
        }

        WriteLength(output, 0x60, 0x6F, text.Length);
        foreach (var ch in text)
        {
            output.WriteByte((byte)(ch >> 8));
            output.WriteByte((byte)ch);
        }
    }

    private static void WriteInteger(MemoryStream output, long value)
    {
        if (value is >= 0 and <= byte.MaxValue)
        {
            output.WriteByte(0x10);
            output.WriteByte((byte)value);
            return;
        }

        if (value is >= short.MinValue and <= short.MaxValue)
        {
            output.WriteByte(0x11);
            WriteBigEndian(output, (ulong)(ushort)value, 2);
            return;
        }

        if (value is >= int.MinValue and <= int.MaxValue)
        {
            output.WriteByte(0x12);
            WriteBigEndian(output, (ulong)(uint)value, 4);
            return;
        }

        output.WriteByte(0x13);
        WriteBigEndian(output, (ulong)value, 8);
    }

    private static void WriteObjectRef(MemoryStream output, int nodeId, int objectRefSize) =>
        WriteBigEndian(output, (ulong)nodeId, objectRefSize);

    private static void WriteAscii(MemoryStream output, string text)
    {
        foreach (var ch in text)
        {
            output.WriteByte((byte)ch);
        }
    }

    private static void WriteBigEndian(MemoryStream output, ulong value, int byteCount)
    {
        for (var i = byteCount - 1; i >= 0; i--)
        {
            output.WriteByte((byte)(value >> (8 * i)));
        }
    }

    private static int ByteSize(int count) => count switch
    {
        <= 0xFF => 1,
        <= 0xFFFF => 2,
        <= 0xFFFFFF => 3,
        _ => 8,
    };

    private static int ByteSize(ulong value) => value switch
    {
        <= 0xFF => 1,
        <= 0xFFFF => 2,
        <= 0xFFFFFF => 3,
        _ => 8,
    };

    // ---------------------------------------------------------------- decoder

    private static object? ParseObject(ReadOnlySpan<byte> data, int[] offsets, int nodeId, int objectRefSize)
    {
        if (nodeId < 0 || nodeId >= offsets.Length)
        {
            throw new InvalidDataException($"bplist: object reference {nodeId} is out of range.");
        }

        var position = offsets[nodeId];
        var marker = ReadByte(data, position);
        position++;
        var type = marker >> 4;
        var info = marker & 0x0F;

        switch (type)
        {
            case 0x0:
                return info switch
                {
                    0x0 => null,
                    0x8 => false,
                    0x9 => true,
                    _ => throw new InvalidDataException($"bplist: unsupported simple marker 0x{marker:X2}."),
                };
            case 0x1:
            {
                var byteCount = 1 << info;
                var raw = ReadBigEndian(data, position, byteCount);
                // bplist 整数是无符号的：空投的 eventPort 等值可能 >= 0x8000，
                // 早期实现按有符号 short/int 转换会把 49246 解成 -16290。
                return (long)raw;
            }

            case 0x2:
            {
                var byteCount = 1 << info;
                if (byteCount == 4)
                {
                    return (double)BitConverter.Int32BitsToSingle((int)(uint)ReadBigEndian(data, position, 4));
                }

                return BitConverter.Int64BitsToDouble((long)ReadBigEndian(data, position, 8));
            }

            case 0x3:
                return BitConverter.Int64BitsToDouble((long)ReadBigEndian(data, position, 8));

            case 0x4:
            {
                var (length, next) = ReadLength(data, position, info);
                return data.Slice(next, length).ToArray();
            }

            case 0x5:
            {
                var (length, next) = ReadLength(data, position, info);
                return Encoding.ASCII.GetString(data.Slice(next, length));
            }

            case 0x6:
            {
                var (length, next) = ReadLength(data, position, info);
                var chars = new char[length];
                for (var i = 0; i < length; i++)
                {
                    chars[i] = (char)BinaryPrimitives.ReadUInt16BigEndian(data[(next + (i * 2))..]);
                }

                return new string(chars);
            }

            case 0xA:
            {
                var (length, next) = ReadLength(data, position, info);
                var items = new object?[length];
                for (var i = 0; i < length; i++)
                {
                    var childId = (int)ReadBigEndian(data, next + (i * objectRefSize), objectRefSize);
                    items[i] = ParseObject(data, offsets, childId, objectRefSize);
                }

                return items;
            }

            case 0xD:
            {
                var (length, next) = ReadLength(data, position, info);
                var result = new Dictionary<string, object?>(length, StringComparer.Ordinal);
                for (var i = 0; i < length; i++)
                {
                    var keyId = (int)ReadBigEndian(data, next + (i * objectRefSize), objectRefSize);
                    var valueId = (int)ReadBigEndian(data, next + ((length + i) * objectRefSize), objectRefSize);
                    var key = ParseObject(data, offsets, keyId, objectRefSize) as string
                        ?? throw new InvalidDataException("bplist: non-string dictionary key.");
                    result[key] = ParseObject(data, offsets, valueId, objectRefSize);
                }

                return result;
            }

            default:
                throw new InvalidDataException($"bplist: unsupported marker 0x{marker:X2}.");
        }
    }

    private static (int Length, int Next) ReadLength(ReadOnlySpan<byte> data, int position, int info)
    {
        if (info < 0x0F)
        {
            return (info, position);
        }

        var marker = ReadByte(data, position);
        if ((marker >> 4) != 0x1)
        {
            throw new InvalidDataException("bplist: length is not encoded as an integer.");
        }

        var byteCount = 1 << (marker & 0x0F);
        var value = (int)ReadBigEndian(data, position + 1, byteCount);
        return (value, position + 1 + byteCount);
    }

    private static byte ReadByte(ReadOnlySpan<byte> data, int position)
    {
        if (position < 0 || position >= data.Length)
        {
            throw new InvalidDataException("bplist: read past the end of the document.");
        }

        return data[position];
    }

    private static ulong ReadBigEndian(ReadOnlySpan<byte> data, int position, int byteCount)
    {
        if (position < 0 || position + byteCount > data.Length)
        {
            throw new InvalidDataException("bplist: read past the end of the document.");
        }

        ulong value = 0;
        for (var i = 0; i < byteCount; i++)
        {
            value = (value << 8) | data[position + i];
        }

        return value;
    }
}
