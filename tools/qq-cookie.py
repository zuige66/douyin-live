# 把浏览器里复制的 QQ 音乐 Cookie 存进单身汉播放器，并当场验一次会员曲能不能取到音源。
#
# 为什么要有这个（2026-10-28 凌晨）：
#   主人说「我 QQ 音乐已经登录了啊，有会员」，然后重新扫了一次码。
#   auth.json 确实在 00:09:04 被改写了，但里面还是：
#     qqCookie = "uin=3865077183; p_uin=; p_skey="
#   —— 只有 uin，p_skey 是空的，更没有 qm_keyst。
#   插件那边的原话（src/providers/qq.ts:548）：
#     「已扫码登录（基础态）；VIP 曲目若无法播放，请在账号页粘贴完整 Cookie」
#   也就是说这不是操作问题，是**扫码这条路本身拿不到会员票据**，再扫一百次也一样。
#   会员权益靠 qm_keyst（或非空的 p_skey），只有从已登录的浏览器里复制才有。
#
# 怎么用：
#   1. 浏览器打开 https://y.qq.com 并确认右上角是会员账号（已登录）
#   2. F12 → Network → 随便点一个请求 → Request Headers 里的 Cookie 整行复制
#      （或者 Application → Cookies → 把所有键值拼成 "k=v; k=v" 的形式）
#   3. 双击 tools\qq-cookie.cmd
import ctypes
import json
import sys
import urllib.parse
import urllib.request

API = "http://127.0.0.1:5510/api/dsh-music"
CF_UNICODETEXT = 13


def read_clipboard():
    """读文本剪贴板。不用 tkinter —— 它会闪一个窗口出来。

    ⚠️ 这几个 Restype/Argtypes 不能省。64 位 Windows 上 HANDLE 是 8 字节指针，
    ctypes 默认按 c_int 返回，`GlobalLock` 拿到的是被截断的地址，
    结果不是空串就是直接崩 —— 而且崩得莫名其妙，很难往剪贴板上想。"""
    u = ctypes.windll.user32
    k = ctypes.windll.kernel32
    u.OpenClipboard.argtypes = [ctypes.c_void_p]
    u.OpenClipboard.restype = ctypes.c_int
    u.GetClipboardData.argtypes = [ctypes.c_uint]
    u.GetClipboardData.restype = ctypes.c_void_p
    u.CloseClipboard.restype = ctypes.c_int
    k.GlobalLock.argtypes = [ctypes.c_void_p]
    k.GlobalLock.restype = ctypes.c_void_p
    k.GlobalUnlock.argtypes = [ctypes.c_void_p]
    k.GlobalUnlock.restype = ctypes.c_int

    if not u.OpenClipboard(None):
        return ""
    try:
        h = u.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return ""
        p = k.GlobalLock(h)
        if not p:
            return ""
        try:
            return ctypes.wstring_at(p)
        finally:
            k.GlobalUnlock(h)
    finally:
        u.CloseClipboard()


def get(url, timeout=15):
    return json.load(urllib.request.urlopen(url, timeout=timeout))


def post(url, body, timeout=20):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def parse_cookie(s):
    out = {}
    for part in str(s or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def probe_vip():
    """拿一首 QQ 的 VIP 曲当场验：能取到音源就说明会员票据生效了。"""
    try:
        r = get(API + "/search?keyword=" + urllib.parse.quote("一半一半") + "&limit=8", 20)
    except Exception as e:
        return "（验不了：搜索接口没回话 %s）" % e
    cands = [t for t in (r.get("tracks") or []) if t.get("provider") == "qq" and t.get("vip") is True]
    if not cands:
        return "（没找到 QQ 的 VIP 曲来验，跳过）"
    for t in cands[:3]:
        try:
            u = get(API + "/url?id=" + urllib.parse.quote(t["id"]), 20).get("result") or {}
        except Exception:
            continue
        if u.get("url"):
            return "✓ 会员曲能取到音源了：《%s》" % t.get("name")
    return "✗ 会员曲还是取不到音源（qqCookie 里可能缺 qm_keyst）"


def main():
    print("把浏览器里 y.qq.com 的 Cookie 复制到剪贴板，然后运行这个。\n")
    raw = read_clipboard().strip()
    if not raw:
        print("剪贴板是空的 —— 先复制 Cookie 再双击一次。")
        return 1
    if "uin=" not in raw.lower():
        print("剪贴板里没有 uin=，看着不像 QQ 的 Cookie。")
        print("前 120 个字是：", raw[:120])
        return 1

    ck = parse_cookie(raw)
    key = ck.get("qm_keyst") or ck.get("qqmusic_key") or ck.get("music_key") or ck.get("wxskey") or ""
    pskey = ck.get("p_skey") or ""
    print("解析到 %d 个键" % len(ck))
    print("  uin      =", ck.get("uin", "(无)"))
    if key:
        print("  qm_keyst = ...%s（会员票据，有它就能放 VIP）" % key[-6:])
    else:
        print("  qm_keyst = (缺)")
    print("  p_skey   =", ("...%s" % pskey[-6:]) if pskey else "(空)")

    if not key and not pskey:
        print("\n⚠ 这条 Cookie 里既没有 qm_keyst 也没有非空 p_skey ——")
        print("  存进去也只能放免费曲，VIP 曲照样取不到音源。")
        print("  大概是在没登录 y.qq.com（或登录已过期）的时候复制的，")
        print("  先在浏览器打开 https://y.qq.com 确认右上角是会员账号，再复制一次。")
        ans = input("\n还是要先存进去试试吗？(y/N) ").strip().lower()
        if ans != "y":
            return 1

    try:
        r = post(API + "/auth/qq", {"cookie": raw})
    except Exception as e:
        print("存不进去：", e)
        return 1
    print("\n已保存：", r)

    try:
        st = get(API + "/auth/status", 8)
        qq = [p for p in (st.get("providers") or []) if p.get("provider") == "qq"]
        print("插件那边的状态：", "已登录" if (qq and qq[0].get("loggedIn")) else "未登录")
    except Exception:
        pass

    print("\n正在验一首 VIP 曲…")
    print(probe_vip())
    print("\n（桥不用重启：每次点歌都会重新读 auth.json）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
