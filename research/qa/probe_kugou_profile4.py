import json, urllib.request, urllib.error, time

CK = json.load(open(r'E:\Zilux2开发\research\qa\kugou_cookies.json', encoding='utf-8'))
C = {c['name']: c['value'] for c in CK}
cookie = '; '.join(f'{k}={v}' for k, v in C.items() if v)
token, userid = C['token'], C['userid']

def get(url, extra_headers=None):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Referer': 'https://www.kugou.com/',
        'Cookie': cookie,
        'Accept': 'application/json, text/plain, */*',
    })
    for k, v in (extra_headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return r.status, r.read()[:400].decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:300].decode('utf-8', 'replace')
    except Exception as e:
        return 'ERR', repr(e)

cands = [
    f'http://login.user.kugou.com/v2/get_userinfo?token={token}&userid={userid}&appid=1014&clientver=20489',
    f'http://login.user.kugou.com/v1/get_user_info?token={token}&userid={userid}&appid=1014&clientver=20489',
    f'http://relation.user.kugou.com/v1/get_userinfo?token={token}&userid={userid}&appid=1005&clientver=20489',
    f'https://wwwapi.kugou.com/wapi/user/get_user_detail?token={token}&userid={userid}&appid=1005&clientver=20489',
    f'https://wwwapi.kugou.com/userinfo/get_user_info?token={token}&userid={userid}&appid=1005&clientver=20489',
    f'https://m.kugou.com/app/i/getUserInfo.php?cmd=userInfo&userid={userid}&token={token}',
    f'https://m3ws.kugou.com/app/i/getUserInfo.php?cmd=userInfo&userid={userid}&token={token}',
    f'https://kugou.com/api/user/info?userid={userid}&token={token}',
]
for u in cands:
    st, body = get(u)
    print(u.split('?')[0], '->', st, body)
