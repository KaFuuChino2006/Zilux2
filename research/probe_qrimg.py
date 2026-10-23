import json, urllib.request, urllib.parse
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
H = {"User-Agent": UA, "Referer": "https://music.163.com/", "Accept": "*/*"}
def get(url):
    req = urllib.request.Request(url, headers=H)
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read().decode("utf-8", "replace")
j = json.loads(get("https://music.163.com/api/login/qrcode/unikey?type=1"))
key = j["unikey"]
for u in [f"https://music.163.com/api/login/qrcode/create?key={urllib.parse.quote(key)}",
          f"https://music.163.com/api/login/qrcode/create?key={key}&qrheadimgurl=1"]:
    try:
        body = get(u)
        print(u.split('?')[0], "->", body[:180])
    except Exception as e:
        print("ERR", u, e)
