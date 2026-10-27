# 出网易云音乐登录二维码，打开网易云的登录页，然后一直等到扫码成功。
#
# 为什么要有这个（2026-10-27 深夜）：
#   热榜垫歌走的是网易云热歌榜（/chart?id=3778678），网易云**没登录**时
#   这些 VIP 曲一律只能拿到 30 秒试听 —— 日志里每首都是
#   「只有试听片段，先垫上《xxx》—— 想放全曲得登录音源」，
#   观众听到的就是「放着放着就断了，一首歌只听得到半分钟」。
#   点歌那边也一样，只是点歌已经改成优先挑登录了的音源（QQ），
#   热榜是榜单曲目、换不了源，只能登录。
#
# 走的是单身汉播放器（DSH 内那个）的本地接口，不碰桥，所以桥重启与否都能用。
import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API = os.environ.get("DSH_MUSIC_API") or "http://127.0.0.1:5510/api/dsh-music"
OUT_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".tmp"))
WAIT_SEC = 180

# 网易云的扫码状态码（见插件 src/providers/netease.ts）
PHASE = {
    800: "二维码过期了",
    801: "等你扫码",
    802: "扫到了，在手机上点「确认登录」",
    803: "登录成功",
}


def get(url, timeout=15):
    return json.load(urllib.request.urlopen(url, timeout=timeout))


def post(url, body, timeout=20):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def netease_logged_in():
    st = get(API + "/auth/status", 8)
    for p in st.get("providers") or []:
        if p.get("provider") == "netease":
            return bool(p.get("loggedIn"))
    return False


def save_qr_image(img):
    """把接口回的那串 data URL 落成文件，返回路径（失败返回空串）。

    ⚠️ 两家回的不是一种东西：
       QQ     → `data:image/png;base64,iVBOR...`
       网易云 → `data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns...`（URL 编码的 SVG）
    只按 base64 解会直接报 "Incorrect padding" —— 今晚就是这么撞上的。"""
    if not img:
        return ""
    head, _, payload = img.partition(",")
    if not payload:
        payload = img
        head = ""
    try:
        if "svg" in head.lower() or payload.lstrip().startswith("%3Csvg"):
            svg = urllib.parse.unquote(payload).lstrip()
            path = os.path.join(OUT_DIR, "netease-login.svg")
            with open(path, "w", encoding="utf-8") as f:
                f.write(svg)
            return path
        raw = base64.b64decode(payload + "=" * (-len(payload) % 4))
        png = os.path.join(OUT_DIR, "netease-login.png")
        with open(png, "wb") as f:
            f.write(raw)
        try:
            from PIL import Image

            im = Image.open(png).convert("L")
            big = os.path.join(OUT_DIR, "netease-login-big.png")
            im.resize((im.width * 4, im.height * 4), Image.NEAREST).save(big)
            return big
        except Exception:
            return png
    except Exception as e:
        print("二维码存不下来（不影响扫码，用浏览器那个页面就行）：", e)
        return ""


def main():
    try:
        st = get(API + "/auth/status", 8)
    except Exception as e:
        print("连不上音乐播放器（DSH 里的单身汉没开？）：", e)
        return 1

    for p in st.get("providers") or []:
        print("  %-8s %s" % (p.get("provider"), "已登录" if p.get("loggedIn") else "未登录"))
    if netease_logged_in():
        print("\n网易云已经登录了，不用再扫。")
        return 0

    try:
        d = post(API + "/auth/netease/qr", {})
    except Exception as e:
        print("取二维码失败：", e)
        return 1
    key = str(d.get("key") or "")
    if not key:
        print("没拿到 key：", d)
        return 1

    try:
        q = get(API + "/auth/netease/qr/create?key=" + urllib.parse.quote(key), 20)
    except Exception as e:
        print("生成二维码失败：", e)
        return 1
    img = str(q.get("img") or "")
    login_url = str(q.get("url") or "")
    if not img and not login_url:
        print("没拿到二维码：", q)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    shown_file = save_qr_image(img)

    print("\n二维码已生成。")
    if login_url:
        print("正在打开网易云的登录页：", login_url)
        print("页面上就有二维码，用手机上的网易云音乐扫它，扫完点「确认登录」。")
    if shown_file:
        print("（二维码图片也存了一份：%s）" % shown_file)
    if os.environ.get("NETEASE_LOGIN_NO_OPEN") != "1":
        opened = False
        for target in [login_url, shown_file]:
            if opened or not target:
                continue
            try:
                os.startfile(target)  # noqa: S606  Windows 专用
                opened = True
            except Exception:
                pass
        if not opened:
            print("（自动打开失败，手动打开上面那个地址或文件）")

    deadline = time.time() + WAIT_SEC
    last = ""
    while time.time() < deadline:
        try:
            r = get(API + "/auth/netease/qr/check?key=" + urllib.parse.quote(key), 12)
            code = int((r.get("qr") or {}).get("code") or 0)
            text = PHASE.get(code, "等一会儿（%s）" % code)
            if text != last:
                print("  [%s] %s" % (time.strftime("%H:%M:%S"), text))
                last = text
            if code == 803:
                if netease_logged_in():
                    print("\n登录成功！现在热榜和点歌都能放整首了（之前只有 30 秒试听）。")
                    return 0
                print(
                    "\n服务端说登上了，但插件没接住 Cookie ——\n"
                    "打开 DSH 里的音乐界面，在账号页用「粘贴 Cookie」登录。"
                )
                return 1
            if code == 800:
                print("\n二维码过期了 —— 再双击一次这个文件就行。")
                return 1
        except Exception:
            pass
        time.sleep(2)

    print("\n等了 %d 秒还没扫，二维码过期了 —— 再双击一次这个文件。" % WAIT_SEC)
    return 1


if __name__ == "__main__":
    sys.exit(main())
