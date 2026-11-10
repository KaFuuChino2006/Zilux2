using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Zilux2.Online.Kugou;

// 酷狗设备身份：mid 是 GUID 的 MD5 十进制大数；dfid 由 /risk/*/r_register_dev 注册得到。
// 扫码登录前必须先注册 dfid，否则签发的 token 在云歌单接口上会返回 20017。
internal sealed class KugouDevice
{
    private const string FileName = "kugou-device.json";
    private const string RegisterPath = "/risk/v3/r_register_dev";

    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static KugouDevice? _current;

    private KugouDevice(string guid, string mid, string dfid)
    {
        Guid = guid;
        Mid = mid;
        Dfid = dfid;
    }

    public static KugouDevice Current
    {
        get
        {
            if (_current is not null)
            {
                return _current;
            }

            lock (typeof(KugouDevice))
            {
                _current ??= LoadOrCreate();
                return _current;
            }
        }
    }

    public string Guid { get; }

    public string Mid { get; private set; }

    public string Dfid { get; private set; }

    public bool HasRegisteredDevice => !string.IsNullOrWhiteSpace(Dfid) && Dfid != "-";

    public static async Task<KugouDevice> EnsureRegisteredAsync(
        string? token,
        string? userId,
        CancellationToken cancellationToken,
        bool force = false)
    {
        var device = Current;
        if (device.HasRegisteredDevice && !force)
        {
            return device;
        }

        // 匿名注册不会返回 dfid（上游 data=[]）；必须带登录 token 注册。
        if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(userId))
        {
            return device;
        }

        await Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (device.HasRegisteredDevice && !force)
            {
                return device;
            }

            try
            {
                if (force)
                {
                    // 酷狗 dfid 与签发它的 token 绑定：换账号/重新扫码后必须重新注册，
                    // 否则新 token 配旧 dfid，get_all_list 会 401/20017，页面显示已登录但没有歌单。
                    device.Dfid = "-";
                }

                var dfid = await RegisterAsync(device, token, userId, cancellationToken).ConfigureAwait(false);
                if (!string.IsNullOrWhiteSpace(dfid))
                {
                    device.Dfid = dfid;
                    device.Save();
                    OnlineHttp.Info($"[kugou] device registered dfid={Shorten(dfid)} user={userId}");
                }
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                OnlineHttp.Warn($"[kugou] device register failed: {OnlineHttp.Describe(exception)}");
            }

            return device;
        }
        finally
        {
            Gate.Release();
        }
    }

    // 已有账号 cookie 里没有 dfid 时，用本机持久化的设备身份兜底。
    public static string ResolveDfid(string? cookieDfid)
    {
        if (!string.IsNullOrWhiteSpace(cookieDfid) && cookieDfid != "-")
        {
            return cookieDfid;
        }

        return Current.HasRegisteredDevice ? Current.Dfid : "-";
    }

    private static async Task<string> RegisterAsync(
        KugouDevice device,
        string? token,
        string? userId,
        CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["availableRamSize"] = 4983533568L,
            ["availableRomSize"] = 48114719L,
            ["availableSDSize"] = 48114717L,
            ["basebandVer"] = string.Empty,
            ["batteryLevel"] = 100,
            ["batteryStatus"] = 3,
            ["brand"] = "Redmi",
            ["buildSerial"] = "unknown",
            ["device"] = "marble",
            ["imei"] = device.Guid,
            ["imsi"] = string.Empty,
            ["manufacturer"] = "Xiaomi",
            ["uuid"] = device.Guid,
            ["accelerometer"] = false,
            ["accelerometerValue"] = string.Empty,
            ["gravity"] = false,
            ["gravityValue"] = string.Empty,
            ["gyroscope"] = false,
            ["gyroscopeValue"] = string.Empty,
            ["light"] = false,
            ["lightValue"] = string.Empty,
            ["magnetic"] = false,
            ["magneticValue"] = string.Empty,
            ["orientation"] = false,
            ["orientationValue"] = string.Empty,
            ["pressure"] = false,
            ["pressureValue"] = string.Empty,
            ["step_counter"] = false,
            ["step_counterValue"] = string.Empty,
            ["temperature"] = false,
            ["temperatureValue"] = string.Empty,
        });
        var (body, seed) = KugouCrypto.AesEncryptBase64(payload);
        var p = KugouCrypto.RsaPkcs1Hex(JsonSerializer.Serialize(new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["aes"] = seed,
            ["uid"] = userId ?? "0",
            ["token"] = token ?? string.Empty,
        }));

        var parameters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["part"] = "1",
            ["platid"] = "1",
            ["p"] = p,
        };
        if (!string.IsNullOrWhiteSpace(token))
        {
            parameters["token"] = token;
        }

        if (!string.IsNullOrWhiteSpace(userId))
        {
            parameters["userid"] = userId;
        }

        using var client = new KugouClient(device.Mid, device.Dfid);
        var bytes = await client
            .PostRawAsync(RegisterPath, body, "application/x-www-form-urlencoded", parameters, null, cancellationToken, "https://userservice.kugou.com")
            .ConfigureAwait(false);
        var text = Encoding.UTF8.GetString(bytes);
        if (!text.TrimStart().StartsWith('{'))
        {
            text = KugouCrypto.AesDecryptBase64(Convert.ToBase64String(bytes), seed);
        }

        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
        if (!root.TryGetProperty("status", out var status) || status.GetInt32() != 1)
        {
            var code = root.TryGetProperty("error_code", out var codeNode) ? codeNode.ToString() : "?";
            throw new OnlineUpstreamException($"酷狗设备注册失败（{code}）", 502);
        }

        return root.TryGetProperty("data", out var data) && data.TryGetProperty("dfid", out var dfidNode)
            ? dfidNode.GetString() ?? string.Empty
            : string.Empty;
    }

    private static KugouDevice LoadOrCreate()
    {
        var path = Path.Combine(HostFolders.Root, FileName);
        try
        {
            if (File.Exists(path))
            {
                var document = JsonSerializer.Deserialize<DeviceDocument>(File.ReadAllText(path, Encoding.UTF8));
                if (!string.IsNullOrWhiteSpace(document?.Guid) && !string.IsNullOrWhiteSpace(document.Mid))
                {
                    return new KugouDevice(document.Guid, document.Mid, document.Dfid ?? "-");
                }
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            OnlineHttp.Warn($"[kugou] device load failed: {exception.GetType().Name}");
        }

        var guid = System.Guid.NewGuid().ToString();
        var device = new KugouDevice(guid, KugouSignature.CalculateMid(guid), "-");
        device.Save();
        OnlineHttp.Info($"[kugou] device created mid={Shorten(device.Mid)}");
        return device;
    }

    private void Save()
    {
        var path = Path.Combine(HostFolders.Root, FileName);
        try
        {
            Directory.CreateDirectory(HostFolders.Root);
            var json = JsonSerializer.Serialize(new DeviceDocument { Guid = Guid, Mid = Mid, Dfid = Dfid });
            var temp = path + ".tmp";
            File.WriteAllText(temp, json, new UTF8Encoding(false));
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            OnlineHttp.Warn($"[kugou] device save failed: {exception.Message}");
        }
    }

    private static string Shorten(string value) => value[..Math.Min(8, value.Length)];

    private sealed class DeviceDocument
    {
        [JsonPropertyName("guid")] public string? Guid { get; set; }

        [JsonPropertyName("mid")] public string? Mid { get; set; }

        [JsonPropertyName("dfid")] public string? Dfid { get; set; }
    }
}
