import json, time, urllib.request
import http.cookiejar
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://music.163.com/", "Accept": "*/*"})
    with opener.open(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8", "replace"))
j = get("https://music.163.com/api/login/qrcode/unikey?type=1")
key = j.get("unikey","")
print("key", key)
print("cookies after unikey:", [(c.name, c.value[:12]) for c in jar])
for i in range(10):
    time.sleep(1.5)
    j2 = get(f"https://music.163.com/api/login/qrcode/client/login?key={key}&type=1")
    print(i, "code=", j2.get("code"), "cookies:", [(c.name, c.value[:10]) for c in jar])
