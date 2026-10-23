import base64, hashlib, json, time, urllib.request, urllib.error

PEM = """-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----"""
SALT = 'OIlwieks28dk2k092lksi2UIkp'

def der_pubkey(pem):
    body = ''.join(pem.strip().splitlines()[1:-1])
    der = base64.b64decode(body)
    i = 0
    def tlv(buf, i):
        tag = buf[i]; ln = buf[i+1]; i += 2
        if ln & 0x80:
            n = ln & 0x7f
            ln = int.from_bytes(buf[i:i+n], 'big'); i += n
        return tag, buf[i:i+ln], i+ln
    _, seq, _ = tlv(der, i)
    i = 0
    _, _, i = tlv(seq, i)             # AlgorithmIdentifier
    _, bits, _ = tlv(seq, i)
    _, rsa, _ = tlv(bits[1:], 0)      # skip unused-bits byte
    i = 0
    _, n, i = tlv(rsa, i)
    _, e, i = tlv(rsa, i)
    return int.from_bytes(n, 'big'), int.from_bytes(e, 'big')

N, E = der_pubkey(PEM)
KEYLEN = (N.bit_length() + 7) // 8

def rsa_encrypt(text):
    data = text.encode('utf-8')
    padded = data.ljust(KEYLEN, b'\x00')
    assert len(padded) == KEYLEN
    enc = pow(int.from_bytes(padded, 'big'), E, N)
    return enc.to_bytes(KEYLEN, 'big').hex().upper()

def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()

CK = json.load(open(r'E:\Zilux2开发\research\qa\kugou_cookies.json', encoding='utf-8'))
COOKIES = {c['name']: c['value'] for c in CK}
token, userid, mid = COOKIES['token'], COOKIES['userid'], COOKIES['mid']

def post(appid, clientver, extra_headers=None, extra_body=None, uuid='-', use_cookie=True):
    ct = int(time.time() * 1000)
    p = rsa_encrypt(json.dumps({"clienttime": ct, "token": token}, separators=(',', ':')))
    key = md5(f"{appid}{SALT}{clientver}{ct}")
    body = {"p": p, "appid": appid, "mid": mid, "clientver": str(clientver), "source": 0,
            "clienttime": ct, "uuid": uuid, "userid": int(userid), "key": key}
    if extra_body:
        body.update(extra_body)
    raw = json.dumps(body).encode('utf-8')
    req = urllib.request.Request('http://relation.user.kugou.com/v1/get_my_userinfo', data=raw,
                                 headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0",
                                          "Referer": "https://www.kugou.com/"},
                                 method='POST')
    if use_cookie:
        ck = '; '.join(f'{k}={v}' for k, v in COOKIES.items() if v != '-')
        req.add_header('Cookie', ck)
    for k, v in (extra_headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return resp.status, resp.read().decode('utf-8', 'replace')[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')[:300]
    except Exception as e:
        return 'ERR', repr(e)

cases = [
    ('base appid1005 cv20489', lambda: post(1005, 20489)),
    ('appid1014 cv20489', lambda: post(1014, 20489)),
    ('appid1005 cv20489 + device hdrs', lambda: post(1005, 20489, {'dfid': '-', 'mid': mid, 'clienttime': str(int(time.time()*1000)), 'kg-rc': '1'})),
    ('appid1005 cv0', lambda: post(1005, 0)),
    ('appid1005 guid uuid', lambda: post(1005, 20489, uuid='00000000-0000-0000-0000-000000000000')),
    ('appid1005 no cookie', lambda: post(1005, 20489, use_cookie=False)),
]
for label, fn in cases:
    status, body = fn()
    print(label, '->', status, body)
