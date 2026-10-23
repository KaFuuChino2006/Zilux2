import json, time, urllib.request
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
def get(url, cookie=None):
    headers = {"User-Agent": UA, "Referer": "https://music.163.com/", "Accept": "*/*"}
    if cookie: headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8", "replace")), r.headers
j, hdr = get("https://music.163.com/api/login/qrcode/unikey?type=1")
key = j.get("unikey","")
sc = hdr.get("Set-Cookie") or ""
nmt = sc.split(";")[0]
print("key", key, "frozen cookie", nmt)
for i in range(8):
    time.sleep(1.5)
    j2, h2 = get(f"https://music.163.com/api/login/qrcode/client/login?key={key}&type=1", nmt)
    print(i, "code=", j2.get("code"), "msg=", j2.get("message"))
