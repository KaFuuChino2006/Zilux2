import base64, hashlib, json, random, string, time, urllib.request, urllib.error
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

PEM = """-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----"""
SALT_WEB = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
SALT_ANDROID = 'OIlwieks28dk2k092lksi2UIkp'

def der_pubkey(pem):
    body = ''.join(pem.strip().splitlines()[1:-1])
    der = base64.b64decode(body)
    def tlv(buf, i):
        tag = buf[i]; ln = buf[i+1]; i += 2
        if ln & 0x80:
            n = ln & 0x7f
            ln = int.from_bytes(buf[i:i+n], 'big'); i += n
        return tag, buf[i:i+ln], i+ln
    _, seq, _ = tlv(der, 0)
    i = 0
    _, _, i = tlv(seq, i)
    _, bits, _ = tlv(seq, i)
    _, rsa, _ = tlv(bits[1:], 0)
    i = 0
    _, n, i = tlv(rsa, i)
    _, e, i = tlv(rsa, i)
    return int.from_bytes(n, 'big'), int.from_bytes(e, 'big')

N, E = der_pubkey(PEM)
KEYLEN = (N.bit_length() + 7) // 8

def rsa_raw(text):
    data = text.encode('utf-8')
    padded = data.ljust(KEYLEN, b'\x00')
    enc = pow(int.from_bytes(padded, 'big'), E, N)
    return enc.to_bytes(KEYLEN, 'big').hex()

def md5(s): return hashlib.md5(s.encode('utf-8')).hexdigest()

def aes_enc_hex(text, key, iv):
    c = AES.new(key.encode('utf-8'), AES.MODE_CBC, iv.encode('utf-8'))
    return c.encrypt(pad(text.encode('utf-8'), 16)).hex()

def aes_dec_hex(hexstr, key, iv):
    c = AES.new(key.encode('utf-8'), AES.MODE_CBC, iv.encode('utf-8'))
    return unpad(c.decrypt(bytes.fromhex(hexstr)), 16).decode('utf-8', 'replace')

def sign_android(params, data):
    s = ''.join(f'{k}={json.dumps(v, separators=(",", ":")) if isinstance(v, (dict, list)) else v}'
                for k, v in sorted(params.items()))
    return md5(SALT_ANDROID + s + data + SALT_ANDROID)

CK = json.load(open(r'E:\Zilux2开发\research\qa\kugou_cookies.json', encoding='utf-8'))
C = {c['name']: c['value'] for c in CK}
token, userid, mid = C['token'], C['userid'], C['mid']

def login_by_token():
    now = int(time.time() * 1000)
    sec = now // 1000
    p3 = aes_enc_hex(json.dumps({"clienttime": sec, "token": token}, separators=(',', ':')) , '90b8382a1bb4ccdcf063102053fd75b8', 'f063102053fd75b8')
    temp_key = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(16))
    ekey = md5(temp_key)[:32]
    eiv = ekey[16:]
    params_str = aes_enc_hex('{}', ekey, eiv)
    pk = rsa_raw(json.dumps({"clienttime_ms": now, "key": temp_key}, separators=(',', ':')))
    data = {
        'dfid': C.get('dfid', '-'),
        'p3': p3,
        'plat': 1,
        't1': 0,
        't2': 0,
        't3': 'MCwwLDAsMCwwLDAsMCwwLDA=',
        'pk': pk,
        'params': params_str,
        'userid': userid,
        'clienttime_ms': now,
    }
    body = json.dumps(data, separators=(',', ':'))
    query = {
        'dfid': C.get('dfid', '-'), 'mid': mid, 'uuid': '-', 'appid': 1005,
        'clientver': 20489, 'clienttime': sec, 'token': token, 'userid': userid,
    }
    query['signature'] = sign_android(query, body)
    url = 'http://login.user.kugou.com/v5/login_by_token?' + '&'.join(f'{k}={v}' for k, v in query.items())
    req = urllib.request.Request(url, data=body.encode('utf-8'), method='POST', headers={
        'Content-Type': 'application/json',
        'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
        'dfid': C.get('dfid', '-'), 'mid': mid, 'clienttime': str(sec),
        'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1', 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
        'Cookie': f'token={token}; userid={userid}; mid={mid}; kg_mid={mid}',
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.read().decode('utf-8', 'replace'), temp_key
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace'), temp_key

status, body, temp_key = login_by_token()
print('status', status)
print('body', body[:600])
try:
    j = json.loads(body)
    secu = j.get('data', {}).get('secu_params')
    if secu:
        dec = aes_dec_hex(secu, md5(temp_key)[:32], md5(temp_key)[16:32])
        print('secu decrypted', dec[:400])
except Exception as e:
    print('parse err', e)
