# 出 QQ 音乐登录二维码，用默认看图程序打开，然后一直等到扫码成功。
#
# 为什么要有这个：二维码只有两分钟寿命，靠人转手递过去经常来不及。
# 双击 tools\qq-login.cmd 就能自己出一张，扫完窗口里会写「登录成功」。
#
# 走的是单身汉播放器（DSH 内那个）的本地接口，不碰桥，所以桥重启与否都能用。
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API = os.environ.get("DSH_MUSIC_API") or "http://127.0.0.1:5510/api/dsh-music"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".tmp")
OUT = os.path.abspath(os.path.join(OUT_DIR, "qq-login-big.png"))
WAIT_SEC = 180


def get(url, timeout=15):
    return json.load(urllib.request.urlopen(url, timeout=timeout))


def post(url, body, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def main():
    try:
        st = get(API + "/auth/status", 8)
    except Exception as e:
        print("连不上音乐播放器（DSH 里的单身汉没开？）：", e)
        return 1

    for p in st.get("providers") or []:
        print("  %-8s %s" % (p.get("provider"), "已登录" if p.get("loggedIn") else "未登录"))
    if any(p.get("provider") == "qq" and p.get("loggedIn") for p in st.get("providers") or []):
        print("\nQQ 音乐已经登录了，不用再扫。")
        return 0

    try:
        d = post(API + "/auth/qq/qr", {})
    except Exception as e:
        print("取二维码失败：", e)
        return 1
    if not d.get("ok") or not d.get("img"):
        print("没拿到二维码：", d)
        return 1

    import base64

    raw = d["img"].split(",", 1)[1]
    os.makedirs(OUT_DIR, exist_ok=True)
    png = os.path.join(OUT_DIR, "qq-login.png")
    with open(png, "wb") as f:
        f.write(base64.b64decode(raw))
    try:
        from PIL import Image

        im = Image.open(png).convert("L")
        im.resize((im.width * 4, im.height * 4), Image.NEAREST).save(OUT)
        shown = OUT
    except Exception:
        shown = png

    print("\n二维码已生成，正在打开：", shown)
    print("用手机 QQ 或 QQ 音乐扫它，扫完在手机上点「确认登录」。")
    if os.environ.get("QQ_LOGIN_NO_OPEN") != "1":
        try:
            os.startfile(shown)  # noqa: S606  Windows 专用
        except Exception:
            print("（自动打开失败，手动双击上面这个文件）")

    deadline = time.time() + WAIT_SEC
    last = ""
    while time.time() < deadline:
        url = (
            f"{API}/auth/qq/qr/check?qrsig={urllib.parse.quote(d['qrsig'])}"
            f"&ptLoginSig={urllib.parse.quote(d['ptLoginSig'])}"
        )
        try:
            r = get(url, 9)
            ph = str((r.get("qr") or {}).get("phase") or "")
            if ph and ph != last:
                print("  [%s] %s" % (time.strftime("%H:%M:%S"), ph))
                last = ph
            if ph == "success":
                st = get(API + "/auth/status", 8)
                ok = [p for p in st.get("providers") or [] if p.get("provider") == "qq"]
                print("\n登录成功！QQ 音乐：", "已登录" if (ok and ok[0].get("loggedIn")) else "状态还没刷新，等几秒")
                print("现在点歌就能放整首了（之前只有 30 秒试听）。")
                return 0
            if ph in ("given-up", "expired"):
                print("\n二维码过期了 —— 再双击一次这个文件就行。")
                return 1
        except Exception:
            pass
        time.sleep(2)

    print("\n等了 %d 秒还没扫，二维码过期了 —— 再双击一次这个文件。" % WAIT_SEC)
    return 1


if __name__ == "__main__":
    sys.exit(main())
