using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace Zilux2.Local;

/// <summary>
/// Windows Property System（IPropertyStore）标签写入：System.Title / System.Music.Artist /
/// System.Music.AlbumTitle / System.Music.AlbumArtist / System.Music.TrackNumber / System.Media.Year。
/// 能否写入由系统的文件格式属性处理器决定（MP3/FLAC/M4A-AAC 通常可写；DSF/APE/OGG-OPUS/WMA/AIFF
/// 可能没有可写处理器），失败只返回中文错误文案，不抛到调用方。封面不写（契约 §16）。
/// </summary>
internal static class LocalTagWriter
{
    private const uint GpsReadWrite = 0x00000002;

    // 注意：SHGetPropertyStoreFromParsingName 不接受 GPS_READWRITE | GPS_BESTEFFORT(0x42)，
    // 会直接返回 E_INVALIDARG（0x80070057）。这里改用 GPS_READWRITE | GPS_NO_OPLOCK(0x82)：
    // 打开可写 store 但不加机会锁，避免与播放器/扫描器占用冲突。
    private const uint GpsNoOplock = 0x00000080;

    private const ushort VtEmpty = 0;
    private const ushort VtI4 = 3;
    private const ushort VtBstr = 8;
    private const ushort VtUi4 = 19;
    private const ushort VtLpwstr = 31;

    // PROPVARIANT 的 vt 在偏移 0、联合体在偏移 8（x86/x64 相同）。这里按原生内存手工读写，
    // 避免 Explicit 布局结构在 32/64 位下尺寸不一致导致 GetValue 写坏堆。
    private const int PropVariantUnionOffset = 8;
    private const int PropVariantBufferBytes = 64;

    private const int ShcneUpdateItem = 0x00002000;
    private const uint ShcnfPathW = 0x0005;

    private static readonly Guid IidPropertyStore = new("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");

    // 只支持任务约定的 6 个字段；缺省（未在请求里出现）的字段不写。
    private static readonly FieldDefinition[] FieldDefinitions =
    {
        new("title", new Guid("F29F85E0-4FF9-1068-AB91-08002B27B3D9"), 2, false),
        new("artist", new Guid("56A3372E-CE9C-11D2-9F0E-006097C686F6"), 2, false),
        new("album", new Guid("56A3372E-CE9C-11D2-9F0E-006097C686F6"), 4, false),
        new("albumArtist", new Guid("56A3372E-CE9C-11D2-9F0E-006097C686F6"), 13, false),
        new("track", new Guid("56A3372E-CE9C-11D2-9F0E-006097C686F6"), 7, true),
        new("year", new Guid("56A3372E-CE9C-11D2-9F0E-006097C686F6"), 5, true),
    };

    private readonly record struct FieldDefinition(string Name, Guid FormatId, uint PropertyId, bool IsNumber);

    internal sealed class TagWriteResult
    {
        public bool Ok { get; init; }

        public string? Error { get; init; }

        public IReadOnlyDictionary<string, object?> Fields { get; init; } = new Dictionary<string, object?>();
    }

    /// <summary>
    /// 写标签入口。textFields 的 value 为 null 表示清空该字段（写空字符串）；numberFields 的
    /// value 为 null 表示不改（音轨号/年份没有「清空」语义）。返回 Ok + 回读到的 6 个字段。
    /// </summary>
    internal static TagWriteResult Write(
        string path,
        IReadOnlyDictionary<string, string?> textFields,
        IReadOnlyDictionary<string, uint?> numberFields)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return Fail("文件不存在或已被移动");
        }

        IPropertyStore? store = null;
        try
        {
            var iid = IidPropertyStore;
            var openFlags = GpsReadWrite | GpsNoOplock;
            var openHr = SHGetPropertyStoreFromParsingName(
                path, IntPtr.Zero, openFlags, ref iid, out store);
            if (openHr < 0 || store is null)
            {
                HostLog.Warn($"[tag] property store open failed path={path} flags=0x{openFlags:X4} hr=0x{openHr:X8}");
                return Fail($"该文件格式没有可写的标签处理器（0x{openHr:X8}）");
            }

            foreach (var definition in FieldDefinitions)
            {
                var writeHr = definition.IsNumber
                    ? WriteNumberField(store, definition, numberFields)
                    : WriteTextField(store, definition, textFields);
                if (writeHr < 0)
                {
                    return Fail($"写入 {definition.Name} 失败（0x{writeHr:X8}）");
                }
            }

            var commitHr = store.Commit();
            if (commitHr < 0)
            {
                return Fail($"提交标签失败（0x{commitHr:X8}）：文件可能只读、正在被占用或格式不支持写入");
            }

            var fields = ReadBack(store);
            try
            {
                // 让资源管理器/缩略图缓存看到新标签（失败不影响写入结果）。
                SHChangeNotify(ShcneUpdateItem, ShcnfPathW, path, IntPtr.Zero);
            }
            catch (Exception exception)
            {
                HostLog.Warn($"[tag] change notify failed: {exception.Message}");
            }

            HostLog.Info($"[tag] wrote {Path.GetFileName(path)}");
            return new TagWriteResult { Ok = true, Fields = fields };
        }
        catch (Exception exception)
        {
            HostLog.Warn($"[tag] write failed {Path.GetFileName(path)}: {exception.GetType().Name}: {exception.Message}");
            return Fail($"写入标签失败：{exception.Message}");
        }
        finally
        {
            if (store is not null)
            {
                try
                {
                    Marshal.ReleaseComObject(store);
                }
                catch (Exception exception)
                {
                    HostLog.Warn($"[tag] release property store failed: {exception.Message}");
                }
            }
        }
    }

    private static TagWriteResult Fail(string error) => new() { Ok = false, Error = error };

    private static int WriteTextField(
        IPropertyStore store, FieldDefinition definition, IReadOnlyDictionary<string, string?> textFields)
    {
        if (!textFields.TryGetValue(definition.Name, out var text))
        {
            return 0;
        }

        var buffer = AllocateVariant();
        var stringPointer = IntPtr.Zero;
        try
        {
            stringPointer = Marshal.StringToCoTaskMemUni(text ?? string.Empty);
            Marshal.WriteInt16(buffer, 0, (short)VtLpwstr);
            Marshal.WriteIntPtr(buffer, PropVariantUnionOffset, stringPointer);
            var key = ToKey(definition);
            return store.SetValue(ref key, buffer);
        }
        finally
        {
            if (stringPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(stringPointer);
            }

            Marshal.FreeHGlobal(buffer);
        }
    }

    private static int WriteNumberField(
        IPropertyStore store, FieldDefinition definition, IReadOnlyDictionary<string, uint?> numberFields)
    {
        if (!numberFields.TryGetValue(definition.Name, out var number) || number is null)
        {
            return 0;
        }

        var buffer = AllocateVariant();
        try
        {
            Marshal.WriteInt16(buffer, 0, (short)VtUi4);
            Marshal.WriteInt32(buffer, PropVariantUnionOffset, unchecked((int)number.Value));
            var key = ToKey(definition);
            return store.SetValue(ref key, buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static Dictionary<string, object?> ReadBack(IPropertyStore store)
    {
        var fields = new Dictionary<string, object?>(FieldDefinitions.Length, StringComparer.Ordinal);
        foreach (var definition in FieldDefinitions)
        {
            fields[definition.Name] = ReadValue(store, definition);
        }

        return fields;
    }

    private static object? ReadValue(IPropertyStore store, FieldDefinition definition)
    {
        var buffer = AllocateVariant();
        try
        {
            var key = ToKey(definition);
            if (store.GetValue(ref key, buffer) < 0)
            {
                return null;
            }

            var vt = (ushort)Marshal.ReadInt16(buffer, 0);
            try
            {
                return vt switch
                {
                    VtLpwstr => Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, PropVariantUnionOffset)),
                    VtBstr => Marshal.PtrToStringBSTR(Marshal.ReadIntPtr(buffer, PropVariantUnionOffset)),
                    VtUi4 => (uint)Marshal.ReadInt32(buffer, PropVariantUnionOffset),
                    VtI4 => (uint)Math.Max(0, Marshal.ReadInt32(buffer, PropVariantUnionOffset)),
                    VtEmpty => null,
                    _ => null,
                };
            }
            finally
            {
                PropVariantClear(buffer);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static PropertyKey ToKey(FieldDefinition definition) =>
        new() { FormatId = definition.FormatId, PropertyId = definition.PropertyId };

    private static IntPtr AllocateVariant()
    {
        var buffer = Marshal.AllocHGlobal(PropVariantBufferBytes);
        for (var offset = 0; offset < PropVariantBufferBytes; offset += 8)
        {
            Marshal.WriteInt64(buffer, offset, 0);
        }

        return buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;

        public uint PropertyId;
    }

    // IPropertyStore 的方法参数统一用 IntPtr 传 PROPVARIANT*：由本类自己按原生布局读写内存，
    // 不依赖运行时的 PROPVARIANT 结构映射。
    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig]
        int GetCount(out uint propertyCount);

        [PreserveSig]
        int GetAt(uint propertyIndex, out PropertyKey key);

        [PreserveSig]
        int GetValue(ref PropertyKey key, IntPtr propertyValue);

        [PreserveSig]
        int SetValue(ref PropertyKey key, IntPtr propertyValue);

        [PreserveSig]
        int Commit();
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int SHGetPropertyStoreFromParsingName(
        string pszPath, IntPtr pbc, uint flags, ref Guid riid, out IPropertyStore? propertyStore);

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int PropVariantClear(IntPtr propVariant);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern void SHChangeNotify(int eventId, uint flags, string item1, IntPtr item2);
}
