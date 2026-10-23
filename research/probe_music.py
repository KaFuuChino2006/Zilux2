"""Probe NetEase + QQ Music anonymous endpoints: search, detail, play URL, lyric, cover, stream.

Run: <bundled python> research/probe_music.py
"""
import json
import sys
import urllib.parse
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)


def req(url, headers=None, data=None, timeout=15):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    r = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        body = resp.read()
        return resp.status, dict(resp.headers), body


def show(tag, status, extra, body, limit=260):
    try:
        text = body.decode("utf-8", "replace")
    except Exception:
        text = repr(body[:200])
    print(f"--- {tag}: http={status} {extra}")
    print(text[:limit].replace("\n", " "))
    print()


def netease():
    print("========== NETEASE ==========")
    q = urllib.parse.quote("晴天")
    ref = {"Referer": "https://music.163.com/"}
    st, h, body = req(
        f"https://music.163.com/api/search/get/web?s={q}&type=1&limit=5&offset=0", ref
    )
    show("search", st, "", body, 160)
    songs = json.loads(body)["result"]["songs"]
    for s in songs[:5]:
        print(
            "song:",
            s["id"],
            s["name"],
            "| fee=",
            s.get("fee"),
            "| dur=",
            s.get("duration"),
            "| artists=",
            [a["name"] for a in s.get("artists", [])],
            "| album=",
            s["album"]["name"],
            "| picId=",
            s["album"].get("picId"),
        )
    ids = [s["id"] for s in songs]
    print()
    # detail (cover / picUrl)
    st, h, body = req(
        "https://music.163.com/api/song/detail?ids=%5B" + ",".join(map(str, ids)) + "%5D",
        ref,
    )
    show("detail", st, "", body, 180)
    try:
        d = json.loads(body)
        for s in d.get("songs", [])[:5]:
            print("detail:", s["id"], s["name"], "picUrl=", s.get("album", {}).get("picUrl"))
    except Exception as e:
        print("detail parse fail:", e)
    print()
    # play url
    ids_param = urllib.parse.quote("[" + ",".join(map(str, ids)) + "]")
    st, h, body = req(
        f"https://music.163.com/api/song/enhance/player/url?ids={ids_param}&br=320000", ref
    )
    show("playurl", st, "", body, 600)
    try:
        d = json.loads(body)["data"]
        urls = [(x.get("id"), x.get("url"), x.get("br"), x.get("type")) for x in d]
        for u in urls:
            print("url:", u)
        good = [u[1] for u in urls if u[1]]
        if good:
            st2, h2, b2 = req(good[0], {"Referer": "https://music.163.com/", "Range": "bytes=0-2047"})
            print("stream:", st2, h2.get("Content-Type"), h2.get("Content-Range"), len(b2), b2[:8].hex())
    except Exception as e:
        print("playurl parse fail:", e)
    print()
    # lyric
    st, h, body = req(
        f"https://music.163.com/api/song/lyric?id={ids[0]}&lv=-1&kv=-1&tv=-1", ref
    )
    show("lyric", st, "", body, 300)
    try:
        d = json.loads(body)
        print("lyric keys:", list(d.keys()))
        print("lrc head:", (d.get("lrc") or {}).get("lyric", "")[:120].replace("\n", " | "))
    except Exception as e:
        print("lyric parse fail:", e)
    print()


def qq():
    print("========== QQ ==========")
    q = urllib.parse.quote("晴天")
    ref = {"Referer": "https://y.qq.com/"}
    st, h, body = req(
        f"https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w={q}&format=json&aggr=1&cr=1&new_json=1",
        ref,
    )
    show("search", st, "", body, 160)
    try:
        d = json.loads(body)
        songs = d["data"]["song"]["list"]
        for s in songs[:5]:
            print(
                "song:",
                s.get("mid"),
                s.get("name"),
                "| id=",
                s.get("id"),
                "| album.mid=",
                s.get("album", {}).get("mid"),
                "| interval=",
                s.get("interval"),
                "| singers=",
                [x.get("name") for x in s.get("singer", [])],
                "| pay=",
                (s.get("pay") or {}).get("pay_play"),
            )
        mids = [s["mid"] for s in songs]
        album_mids = [s.get("album", {}).get("mid") for s in songs]
    except Exception as e:
        print("qq search parse fail:", e)
        return
    print()
    # cover
    st, h, body = req(f"https://y.gtimg.cn/music/photo_new/T002R300x300M000{album_mids[0]}.jpg")
    print(f"cover: http={st} type={h.get('Content-Type')} bytes={len(body)}")
    print()
    # vkey
    guid = "3982823384"
    payload = {
        "req": {
            "module": "CDN.SrfCdnDispatchServer",
            "method": "GetCdnDispatch",
            "param": {"guid": guid, "calltype": 0, "userip": ""},
        },
        "req_0": {
            "module": "vkey.GetVkeyServer",
            "method": "CgiGetVkey",
            "param": {
                "guid": guid,
                "songmid": mids,
                "songtype": [0] * len(mids),
                "uin": "0",
                "loginflag": 1,
                "platform": "20",
            },
        },
        "comm": {"uin": "0", "format": "json", "ct": 24, "cv": 0},
    }
    body_bytes = json.dumps(payload).encode()
    st, h, body = req(
        "https://u.y.qq.com/cgi-bin/musicu.fcg",
        {"Referer": "https://y.qq.com/", "Content-Type": "application/json"},
        data=body_bytes,
    )
    show("vkey", st, "", body, 900)
    try:
        d = json.loads(body)
        info = d["req_0"]["data"]["midurlinfo"]
        sip = d["req_0"]["data"].get("sip", [])
        print("sip:", sip[:3])
        for i, it in enumerate(info[:5]):
            purl = it.get("purl")
            print("purl:", mids[i], it.get("songmid"), "purl=", (purl or "")[:80], "result=", it.get("result"), "errtype=", it.get("errtype"))
            if purl:
                url = (sip[0] if sip else "https://isure.stream.qqmusic.qq.com/") + purl
                st2, h2, b2 = req(url, {"Referer": "https://y.qq.com/", "Range": "bytes=0-2047"})
                print("stream:", st2, h2.get("Content-Type"), h2.get("Content-Range"), len(b2), b2[:8].hex())
    except Exception as e:
        print("vkey parse fail:", e)
    print()
    # lyric
    st, h, body = req(
        f"https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid={mids[0]}&format=json&nobase64=1",
        {"Referer": "https://y.qq.com/portal/player.html"},
    )
    show("lyric", st, "", body, 300)


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    if which in ("both", "netease"):
        try:
            netease()
        except Exception as e:
            print("NETEASE ERROR:", repr(e))
    if which in ("both", "qq"):
        try:
            qq()
        except Exception as e:
            print("QQ ERROR:", repr(e))
