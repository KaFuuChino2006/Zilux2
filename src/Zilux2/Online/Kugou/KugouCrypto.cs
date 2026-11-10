using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace Zilux2.Online.Kugou;

// 酷狗的自定义加密组合：
//   - 设备注册：AES-128-CBC(PKCS7, base64) 包住设备 JSON，外层 RSAES-PKCS1-v1_5 包住 { aes, uid, token }
//   - 登录换票：AES-256-CBC(PKCS7, hex) 包住 { access_token }，外层无填充 RSA 包住 { clienttime_ms, key }
//   - 云歌单的 p 参数同样是「无填充 RSA」。
internal static class KugouCrypto
{
    internal const string PublicRsaPem =
        "-----BEGIN PUBLIC KEY-----\n" +
        "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB\n" +
        "-----END PUBLIC KEY-----";

    private const string Alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    private const string UpperAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    public static string RandomLower(int length) => RandomFrom(Alphabet, length);

    public static string RandomUpper(int length) => RandomFrom(UpperAlphabet, length);

    private static string RandomFrom(string alphabet, int length)
    {
        var bytes = RandomNumberGenerator.GetBytes(length);
        var builder = new StringBuilder(length);
        foreach (var value in bytes)
        {
            builder.Append(alphabet[value % alphabet.Length]);
        }

        return builder.ToString();
    }

    // cryptoAesEncrypt：seed 16 字符 -> key=md5(seed)[0:32]、iv=md5(seed)[16:32]，AES-256-CBC，输出 hex。
    public static (string Hex, string Seed) AesEncryptHex(string plainText)
    {
        var seed = RandomLower(16);
        return (AesEncryptHex(plainText, seed), seed);
    }

    public static string AesEncryptHex(string plainText, string seed)
    {
        var digest = KugouSignature.Md5(seed);
        var key = Encoding.UTF8.GetBytes(digest[..32]);
        var iv = Encoding.UTF8.GetBytes(digest[16..32]);
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = key;
        aes.IV = iv;
        using var encryptor = aes.CreateEncryptor();
        var bytes = Encoding.UTF8.GetBytes(plainText);
        return Convert.ToHexString(encryptor.TransformFinalBlock(bytes, 0, bytes.Length)).ToLowerInvariant();
    }

    public static string AesDecryptHex(string hex, string seed)
    {
        var digest = KugouSignature.Md5(seed);
        var key = Encoding.UTF8.GetBytes(digest[..32]);
        var iv = Encoding.UTF8.GetBytes(digest[16..32]);
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = key;
        aes.IV = iv;
        using var decryptor = aes.CreateDecryptor();
        var bytes = Convert.FromHexString(hex);
        return Encoding.UTF8.GetString(decryptor.TransformFinalBlock(bytes, 0, bytes.Length));
    }

    // playlistAesEncrypt：seed 6 字符 -> key=md5(seed)[0:16]、iv=md5(seed)[16:32]，AES-128-CBC，输出 base64。
    public static (string Base64, string Seed) AesEncryptBase64(string plainText)
    {
        var seed = RandomLower(6);
        return (AesEncryptBase64(plainText, seed), seed);
    }

    public static string AesEncryptBase64(string plainText, string seed)
    {
        var digest = KugouSignature.Md5(seed);
        var key = Encoding.UTF8.GetBytes(digest[..16]);
        var iv = Encoding.UTF8.GetBytes(digest[16..32]);
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = key;
        aes.IV = iv;
        using var encryptor = aes.CreateEncryptor();
        var bytes = Encoding.UTF8.GetBytes(plainText);
        return Convert.ToBase64String(encryptor.TransformFinalBlock(bytes, 0, bytes.Length));
    }

    public static string AesDecryptBase64(string base64, string seed)
    {
        var digest = KugouSignature.Md5(seed);
        var key = Encoding.UTF8.GetBytes(digest[..16]);
        var iv = Encoding.UTF8.GetBytes(digest[16..32]);
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = key;
        aes.IV = iv;
        using var decryptor = aes.CreateDecryptor();
        var bytes = Convert.FromBase64String(base64);
        return Encoding.UTF8.GetString(decryptor.TransformFinalBlock(bytes, 0, bytes.Length));
    }

    // rsaEncrypt2：RSAES-PKCS1-v1_5，输出小写 hex。
    public static string RsaPkcs1Hex(string plainText)
    {
        using var rsa = RSA.Create();
        rsa.ImportFromPem(PublicRsaPem);
        var encrypted = rsa.Encrypt(Encoding.UTF8.GetBytes(plainText), RSAEncryptionPadding.Pkcs1);
        return Convert.ToHexString(encrypted).ToLowerInvariant();
    }

    // cryptoRSAEncrypt：无填充模幂（明文右补 0 到 key 长度），输出小写 hex。
    public static string RsaRawHex(string plainText)
    {
        using var rsa = RSA.Create();
        rsa.ImportFromPem(PublicRsaPem);
        var parameters = rsa.ExportParameters(false);
        var modulus = new BigInteger(parameters.Modulus!, isUnsigned: true, isBigEndian: true);
        var exponent = new BigInteger(parameters.Exponent!, isUnsigned: true, isBigEndian: true);
        var keyLength = (rsa.KeySize + 7) / 8;
        var raw = Encoding.UTF8.GetBytes(plainText);
        if (raw.Length > keyLength)
        {
            throw new InvalidOperationException("kugou rsa payload too long");
        }

        var padded = new byte[keyLength];
        raw.CopyTo(padded, 0);
        var message = new BigInteger(padded, isUnsigned: true, isBigEndian: true);
        var encrypted = BigInteger.ModPow(message, exponent, modulus);
        return encrypted.ToString("x", CultureInfo.InvariantCulture).PadLeft(keyLength * 2, '0');
    }
}
