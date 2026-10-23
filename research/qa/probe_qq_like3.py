import json, urllib.request, sys, io, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

UIN = "1332977057"
KEY = "Q_H_L_63k3Nmzyr6rZ-7DeJTQef6pbRn3WOlvuEaR48aeeeutAKdWc3GXsgf9stM_uD1908AT3143eolefPQosyH4dDIT9l"
COOKIE = f"uin={UIN}; qqmusic_uin={UIN}; qm_keyst={KEY}; qqmusic_key={KEY}"
UA = "QQMusic 14090008(android 14)"
URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"

def base_comm():
    return {
        "ct": 11, "cv": 14090008, "v": 14090008, "chid": "10003505", "tmeAppID": "qqmusic",
        "QIMEI": "a1b2c3d4e5f60718293a4b5c6d7e8f901234",
        "QIMEI36": "a1b2c3d4e5f60718293a4b5c6d7e8f901234",
        "OpenUDID": "0123456789abcdef0123456789abcdef01234567",
        "udid": "0123456789abcdef0123456789abcdef01234567",
        "OpenUDID2": "0123456789abcdef0123456789abcdef01234567",
        "aid": "0011223344556677", "os_ver": "14", "phonetype": "Pixel 7",
        "devicelevel": "33", "newdevicelevel": "33", "rom": "google",
        "qq": UIN, "authst": KEY, "tmeLoginType": 1,
    }

def post(body, quiet=True):
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data, headers={
        "Content-Type": "application/json", "User-Agent": UA, "Cookie": COOKIE, "Referer": "https://y.qq.com/"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        doc = json.loads(resp.read().decode("utf-8", "replace"))
    item = doc.get("req_0", {})
    code = item.get("code")
    if not quiet:
        print("   global=", doc.get("code"), "code=", code)
    return code

def fan_state(mid):
    data = json.loads(urllib.request.urlopen(urllib.request.Request(URL,
        data=json.dumps({"comm": base_comm(), "req_0": {"module": "music.musicasset.SongFavRead",
        "method": "IsSongFanByMid", "param": {"v_songMid": [mid]}}}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA, "Cookie": COOKIE, "Referer": "https://y.qq.com/"}),
        timeout=20).read().decode("utf-8", "replace"))
    return (data["req_0"]["data"] or {}).get("m_fan", {}).get(mid)

MID, SID = "002t78Qs1Av9Kn", 244115394

def write(method, comm):
    return post({"comm": comm, "req_0": {"module": "music.musicasset.PlaylistDetailWrite",
        "method": method, "param": {"dirId": 201, "v_songInfo": [{"songId": SID, "songType": 0}]}}}, quiet=False)

def ensure_unliked():
    for _ in range(3):
        if fan_state(MID) is False:
            return True
        write("DelSonglist", base_comm())
        time.sleep(0.4)
    return fan_state(MID) is False

variants = [
    ("ref", base_comm()),
    ("plus-uiminint", dict(base_comm(), uin=int(UIN))),
    ("plus-uinstr", dict(base_comm(), uin=UIN)),
    ("plus-format", dict(base_comm(), format="json")),
    ("plus-platform", dict(base_comm(), platform="yqq")),
    ("plus-needNewCode", dict(base_comm(), needNewCode=1)),
    ("ours", dict(base_comm(), format="json", platform="yqq", needNewCode=1, uin=int(UIN))),
]

for label, comm in variants:
    if not ensure_unliked():
        print(label, "SKIP ensure-unliked failed; liked=", fan_state(MID)); continue
    code = write("AddSonglist", comm)
    liked = fan_state(MID)
    print(f"{label}: write-code={code} liked-after={liked}")
    ensure_unliked()

print("final liked:", fan_state(MID))
