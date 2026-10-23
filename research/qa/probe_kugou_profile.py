"""Probe kugou profile endpoint: relation.user.kugou.com /v1/get_my_userinfo.

Implements the same "raw RSA" (no padding) as the KuGouMusicApi util:
- JSON.stringify({clienttime, token}) -> utf8 bytes -> zero-pad to 128 -> modPow(e, n) -> hex
- key = md5(appid + salt + clientver + clienttime)
"""
import base64
import json
import sys
import urllib.request

PEM = """MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB"""


def read_der(data):
    """Return (tag, content, rest) for one DER element."""
    tag = data[0]
    idx = 1
    length = data[idx]
    idx += 1
    if length & 0x80:
        count = length & 0x7F
        length = int.from_bytes(data[idx:idx + count], "big")
        idx += count
    return tag, data[idx:idx + length], data[idx + length:]


def read_int(data):
    tag, content, _ = read_der(data)
    assert tag == 0x02, tag
    return int.from_bytes(content, "big")


_, spki, _ = read_der(base64.b64decode(PEM))
_, algo, rest = read_der(spki)
_, bits, _ = read_der(rest)
# BIT STRING: first byte is unused-bits count
_, rsa_seq, _ = read_der(bits[1:])
n = read_int(rsa_seq)
e = read_int(rsa_seq[len(rsa_seq) - len(rsa_seq):]) if False else None
# parse e properly: sequence contains two INTEGERs
_, first, after_first = read_der(rsa_seq)
n = int.from_bytes(first, "big")
_, second, _ = read_der(after_first)
e = int.from_bytes(second, "big")

APPID = 1005
CLIENTVER = 20489
SALT = "OIlwieks28dk2k092lksi2UIkp"
HOST = "http://relation.user.kugou.com/v1/get_my_userinfo"


def rsa_hex(text):
    raw = text.encode("utf-8")
    key_len = 128
    padded = raw + b"\x00" * (key_len - len(raw))
    value = pow(int.from_bytes(padded, "big"), e, n)
    return format(value, "x").rjust(key_len * 2, "0")


def md5hex(text):
    import hashlib
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def main():
    import time
    clienttime = int(time.time() * 1000)
    token = sys.argv[1] if len(sys.argv) > 1 else "probe-token"
    userid = sys.argv[2] if len(sys.argv) > 2 else "0"
    mid = sys.argv[3] if len(sys.argv) > 3 else "0123456789abcdef0123456789abcdef"
    body = {
        "p": rsa_hex(json.dumps({"clienttime": clienttime, "token": token}, separators=(",", ":"))).upper(),
        "appid": APPID,
        "mid": mid,
        "clientver": CLIENTVER,
        "source": 0,
        "clienttime": clienttime,
        "uuid": "-",
        "userid": int(userid),
        "key": md5hex(f"{APPID}{SALT}{CLIENTVER}{clienttime}"),
    }
    req = urllib.request.Request(
        HOST,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Host": "relation.user.kugou.com",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode("utf-8", "replace")
            print("status", resp.status)
            print(text[:1200])
    except Exception as exc:  # noqa: BLE001
        print("error", type(exc).__name__, exc)


if __name__ == "__main__":
    main()
