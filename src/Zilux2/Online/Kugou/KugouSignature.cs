using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace Zilux2.Online.Kugou;

// 酷狗签名与设备标识：算法来自 KuGouMusicApi 的 util/helper.js / util/util.js。
// signature = md5(salt + 按 key 排序后的 k=v 拼接 + data + salt)
internal static class KugouSignature
{
    public const string AndroidSalt = "OIlwieks28dk2k092lksi2UIkp";
    public const string WebSalt = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";

    public static string Android(IReadOnlyDictionary<string, string> parameters, string data = "")
        => Md5($"{AndroidSalt}{Join(parameters)}{data}{AndroidSalt}");

    public static string Web(IReadOnlyDictionary<string, string> parameters, string data = "")
        => Md5($"{WebSalt}{Join(parameters)}{data}{WebSalt}");

    public static string Md5(string text)
        => Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    // 取流用的 signKey：md5(hash + salt + appid + mid + userid)。
    public static string SignKey(string hash, string mid, string userId, int appId = 1005)
        => Md5($"{hash}57ae12eb6890223e355ccfcb74edf70d{appId}{mid}{userId}");

    // special_recommend 的 key：md5(appid + salt + clientver + clienttime)。
    public static string SignParamsKey(string data, int appId = 1005, int clientVer = 20489)
        => Md5($"{appId}{AndroidSalt}{clientVer}{data}");

    /// <summary>设备 MID：MD5(guid) 的十六进制按 16 进制大数转成十进制字符串。</summary>
    public static string CalculateMid(string guid)
    {
        var digest = Md5(guid);
        var value = BigInteger.Parse("0" + digest, NumberStyles.HexNumber);
        return value.ToString(CultureInfo.InvariantCulture);
    }

    private static string Join(IReadOnlyDictionary<string, string> parameters)
        => string.Concat(parameters
            .OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => $"{pair.Key}={pair.Value}"));
}
