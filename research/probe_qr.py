import json, time, urllib.request, ssl
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
H = {"User-Agent": UA, "Referer": "https://music.163.com/", "Accept": "*/*"}
def get(url):
    req = urllib.request.Request(url, headers=H)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8", "replace")), dict(r.headers)
try:
    j, hdr = get("https://music.163.com/api/login/qrcode/unikey?type=1")
    print("unikey resp:", json.dumps(j, ensure_ascii=False)[:300])
    print("set-cookie:", hdr.get("Set-Cookie", "")[:200])
    key = j.get("unikey") or ""
    print("keyLen", len(key))
    for i in range(8):
        time.sleep(1.5)
        j2, hdr2 = get("https://music.163.com/api/login/qrcode/client/login?key=%s&type=1" % key)
        print(i, "code=", j2.get("code"), "msg=", j2.get("message"), "cookie=", (hdr2.get("Set-Cookie") or "")[:80])
except Exception as e:
    print("ERR", type(e).__name__, e)
