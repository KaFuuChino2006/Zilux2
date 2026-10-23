import json, urllib.request, sys, io, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
UIN = "1332977057"
KEY = "Q_H_L_63k3Nmzyr6rZ-7DeJTQef6pbRn3WOlvuEaR48aeeeutAKdWc3GXsgf9stM_uD1908AT3143eolefPQosyH4dDIT9l"
COOKIE = f"uin={UIN}; qqmusic_uin={UIN}; qm_keyst={KEY}; qqmusic_key={KEY}"
UA = "QQMusic 14090008(android 14)"
URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
def comm():
    return {"ct": 11, "cv": 14090008, "v": 14090008, "chid": "10003505", "tmeAppID": "qqmusic",
        "QIMEI": "a1b2c3d4e5f60718293a4b5c6d7e8f901234",
        "QIMEI36": "a1b2c3d4e5f60718293a4b5c6d7e8f901234",
        "OpenUDID": "0123456789abcdef0123456789abcdef01234567",
        "udid": "0123456789abcdef0123456789abcdef01234567",
        "OpenUDID2": "0123456789abcdef0123456789abcdef01234567",
        "aid": "0011223344556677", "os_ver": "14", "phonetype": "Pixel 7",
        "devicelevel": "33", "newdevicelevel": "33", "rom": "google",
        "qq": UIN, "authst": KEY, "tmeLoginType": 1}
def call(req0, label):
    body = {"comm": comm(), "req_0": req0}
    r = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json", "User-Agent": UA, "Cookie": COOKIE, "Referer": "https://y.qq.com/"})
    doc = json.loads(urllib.request.urlopen(r, timeout=20).read().decode("utf-8", "replace"))
    item = doc.get("req_0", {})
    data = item.get("data") or {}
    print(label, "code=", item.get("code"), "keys=", list(data.keys())[:8] if isinstance(data, dict) else type(data))
    return data
def fan(mid):
    d = call({"module": "music.musicasset.SongFavRead", "method": "IsSongFanByMid", "param": {"v_songMid": [mid]}}, f"fan {mid}")
    return (d or {}).get("m_fan", {}).get(mid)
MID, SID = "002t78Qs1Av9Kn", 244115394
# 清理到未收藏
for _ in range(4):
    if fan(MID) is False: break
    call({"module": "music.musicasset.PlaylistDetailWrite", "method": "DelSonglist",
          "param": {"dirId": 201, "v_songInfo": [{"songId": SID, "songType": 0}]}}, "cleanup")
    time.sleep(0.3)
print("clean liked:", fan(MID))
# 验证关键读接口在 ref 形态 comm 下是否正常
call({"module": "music.musicasset.PlaylistBaseRead", "method": "GetPlaylistByUin", "param": {"uin": UIN}}, "owned-lists")
call({"module": "music.srfDissInfo.DissInfo", "method": "CgiGetDiss",
      "param": {"disstid": 201, "dirid": 201, "tag": True, "song_begin": 0, "song_num": 3, "userinfo": True}}, "liked-diss")
call({"module": "music.musicasset.SongFavRead", "method": "IsSongFanByMid", "param": {"v_songMid": [MID]}}, "fan-recheck")
