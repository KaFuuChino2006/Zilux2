using System.Security.Cryptography;
using System.Text;

namespace Zilux2.Online.Netease;

// eapi（网易云客户端接口）加密的最小实现：AES-128-ECB + MD5，只用 BCL。
// 协议与常量见 research/netease-api.md §2.4（与 research/ncm/package/util/crypto.js 一致）：
//   text   = JSON.stringify(payload)
//   digest = md5("nobody" + uri + "use" + text + "md5forencrypt")   // 32 位小写 hex
//   plain  = uri + "-36cd479b6b5-" + text + "-36cd479b6b5-" + digest
//   params = UPPER(hex(AES-128-ECB-PKCS7(plain, eapiKey)))
// ECB 不使用 IV；报告里的 presetKey/IV 只属于 weapi，本文件不涉及。
internal static class NeteaseApiCrypto
{
    internal const string EapiKey = "e82ckenh8dichen8";

    private const string Separator = "-36cd479b6b5-";

    internal static string EapiEncrypt(string uri, string jsonPayload)
    {
        var digest = Md5Hex($"nobody{uri}use{jsonPayload}md5forencrypt");
        var plain = $"{uri}{Separator}{jsonPayload}{Separator}{digest}";
        return Convert.ToHexString(AesEcbEncrypt(Encoding.UTF8.GetBytes(plain), EapiKey));
    }

    // 仅用于 e_r=true 时的响应解密；默认 e_r=false 的响应是明文 JSON。
    internal static byte[] AesEcbDecrypt(byte[] cipher, string key)
    {
        using var aes = Aes.Create();
        aes.Key = Encoding.UTF8.GetBytes(key);
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.PKCS7;
        using var decryptor = aes.CreateDecryptor();
        return decryptor.TransformFinalBlock(cipher, 0, cipher.Length);
    }

    private static byte[] AesEcbEncrypt(byte[] plain, string key)
    {
        using var aes = Aes.Create();
        aes.Key = Encoding.UTF8.GetBytes(key);
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.PKCS7;
        using var encryptor = aes.CreateEncryptor();
        return encryptor.TransformFinalBlock(plain, 0, plain.Length);
    }

    private static string Md5Hex(string text) =>
        Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
}
