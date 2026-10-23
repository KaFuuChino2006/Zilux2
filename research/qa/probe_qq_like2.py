import json, urllib.request, sys, io
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

def post(body, label):
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data, headers={
        "Content-Type": "application/json", "User-Agent": UA, "Cookie": COOKIE, "Referer": "https://y.qq.com/"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", "replace")
    doc = json.loads(raw)
    item = doc.get("req_0", {})
    print(label, "global=", doc.get("code"), "code=", item.get("code"),
          "retCode=", (item.get("data") or {}).get("retCode") if isinstance(item.get("data"), dict) else None)
    return doc

def search_songs(query):
    doc = post({"comm": base_comm(), "req_0": {"module": "music.search.SearchCgiService",
        "method": "DoSearchForQQMusicDesktop", "param": {"query": query, "num_per_page": 8, "page_num": 1}}}, "search")
    return doc["req_0"]["data"]["body"]["song"]["list"]

def fan_state(mid):
    doc = post({"comm": base_comm(), "req_0": {"module": "music.musicasset.SongFavRead",
        "method": "IsSongFanByMid", "param": {"v_songMid": [mid]}}}, f"read {mid}")
    return (doc["req_0"]["data"] or {}).get("m_fan", {}).get(mid)

def view_liked():
    doc = post({"comm": base_comm(), "req_0": {"module": "music.musicasset.PlaylistDetailRead",
        "method": "GetPlaylistDetail", "param": {"dirId": 201, "num": 5}}}, "view liked (best effort)")
    return doc

# 找一首未收藏的歌
tracks = search_songs("告白气球")
pick = None
for tr in tracks:
    mid = tr.get("mid"); sid = tr.get("id")
    state = fan_state(mid)
    print("candidate", sid, mid, tr.get("name"), "liked=", state)
    if state is False and pick is None:
        pick = tr
if pick is None:
    print("no unliked song found"); sys.exit(1)

sid, mid = pick["id"], pick["mid"]
print("PICK", sid, mid, pick.get("name"))

variants = {
    "ref": base_comm(),
    "plus-format": dict(base_comm(), format="json"),
    "plus-platform": dict(base_comm(), platform="yqq"),
    "plus-needNewCode": dict(base_comm(), needNewCode=1),
    "plus-uin-int": dict(base_comm(), uin=int(UIN)),
    "ours": dict(base_comm(), format="json", platform="yqq", needNewCode=1, uin=int(UIN)),
}

results = {}
for label, comm in variants.items():
    if fan_state(mid):
        # 已由上一个变体加入：先删掉
        post({"comm": base_comm(), "req_0": {"module": "music.musicasset.PlaylistDetailWrite",
            "method": "DelSonglist", "param": {"dirId": 201, "v_songInfo": [{"songId": sid, "songType": 0}]}}}, f"cleanup {label}")
        assert fan_state(mid) is False, "cleanup failed"
    doc = post({"comm": comm, "req_0": {"module": "music.musicasset.PlaylistDetailWrite",
        "method": "AddSonglist", "param": {"dirId": 201, "v_songInfo": [{"songId": sid, "songType": 0}]}}}, f"write {label}")
    results[label] = doc.get("req_0", {}).get("code")

print("RESULTS", json.dumps(results, ensure_ascii=False))

# 清理：确保回到未收藏
if fan_state(mid):
    post({"comm": base_comm(), "req_0": {"module": "music.musicasset.PlaylistDetailWrite",
        "method": "DelSonglist", "param": {"dirId": 201, "v_songInfo": [{"songId": sid, "songType": 0}]}}}, "cleanup final")
print("final liked:", fan_state(mid))
