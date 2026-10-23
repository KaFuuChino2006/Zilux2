import json, urllib.request, sys

UIN = "1332977057"
KEY = "Q_H_L_63k3Nmzyr6rZ-7DeJTQef6pbRn3WOlvuEaR48aeeeutAKdWc3GXsgf9stM_uD1908AT3143eolefPQosyH4dDIT9l"
COOKIE = f"uin={UIN}; qqmusic_uin={UIN}; qm_keyst={KEY}; qqmusic_key={KEY}"
UA = "QQMusic 14090008(android 14)"
URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"

def comm_ref():
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

def comm_ours():
    c = comm_ref()
    c.update({"format": "json", "platform": "yqq", "needNewCode": 1, "uin": int(UIN)})
    return c

def post(body, label):
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data, headers={
        "Content-Type": "application/json", "User-Agent": UA, "Cookie": COOKIE,
        "Referer": "https://y.qq.com/",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", "replace")
    try:
        doc = json.loads(raw)
    except Exception:
        print(label, "NONJSON", raw[:200]); return None
    print(label, "global=", doc.get("code"))
    for k in ("req_0", "req_1"):
        if k in doc:
            item = doc[k]
            print("  ", k, "code=", item.get("code"), "subcode=", item.get("subcode"),
                  "data=", json.dumps(item.get("data"), ensure_ascii=False)[:300])
    return doc

# 1) 搜索拿一首歌的 id/mid
search = {
    "comm": comm_ref(),
    "req_0": {"module": "music.search.SearchCgiService", "method": "DoSearchForQQMusicDesktop",
              "param": {"query": "夜曲", "num_per_page": 3, "page_num": 1}},
}
doc = post(search, "search")
song = None
try:
    lst = doc["req_0"]["data"]["body"]["song"]["list"]
    for item in lst:
        print("candidate", item.get("id"), item.get("mid"), item.get("name"), item.get("title"))
    song = lst[0]
except Exception as e:
    print("no songs", e)
    sys.exit(1)

song_id, song_mid = song["id"], song["mid"]
print("using", song_id, song_mid)

# 2) detail
detail = {"comm": comm_ref(), "req_0": {"module": "music.pf_song_detail_svr", "method": "get_song_detail_yqq",
          "param": {"song_type": 0, "song_mid": song_mid}}}
post(detail, "detail")

# 3) 已收藏状态
read = {"comm": comm_ref(), "req_0": {"module": "music.musicasset.SongFavRead", "method": "IsSongFanByMid",
        "param": {"v_songMid": [song_mid]}}}
post(read, "read-before")

def write(comm, label):
    body = {"comm": comm, "req_0": {"module": "music.musicasset.PlaylistDetailWrite",
            "method": "AddSonglist", "param": {"dirId": 201, "v_songInfo": [{"songId": song_id, "songType": 0}]}}}
    return post(body, label)

write(comm_ref(), "write-ref")
write(comm_ours(), "write-ours")
post(read, "read-after")

# 4) 收尾：取消收藏，保持原状
def unwrite(comm, label):
    body = {"comm": comm, "req_0": {"module": "music.musicasset.PlaylistDetailWrite",
            "method": "DelSonglist", "param": {"dirId": 201, "v_songInfo": [{"songId": song_id, "songType": 0}]}}}
    return post(body, label)

unwrite(comm_ref(), "unwrite-ref")
post(read, "read-final")
