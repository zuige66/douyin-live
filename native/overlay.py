#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""zuige大肥鱼 直播画面 · 原生窗口

为什么不用浏览器（重要，别再改回去）：
  Chrome 的渲染进程在这台机器上每 33 秒 abort() 一次，崩溃前的遥测显示
  JS 堆只有 0.6MB、页面完全静止——跟我们的页面无关，是浏览器这条路本身不行。
  换成「Python 一个进程 + 一块 1920×1080 的 DIB 位图」，没有渲染进程、没有
  合成器、没有 GPU 进程，空闲时 CPU 是 0，跑一整天也不会自己死。

窗口层用 ctypes 直接调 Win32（不用 tkinter：这台机器的 Python 3.13 没带 tk）：
  CreateWindowExW 一个 1920×1080 无边框窗口
  画面先合成进 DIB，再 BitBlt 上去，一次约 2ms
  有动作素材时按 pet.FPS（默认 12）重画；没素材时退回「只在有新弹幕 / 秒数变了时重画」

用法：
  python overlay.py                 # 连本机弹幕桥 127.0.0.1:18081
  python overlay.py --demo          # 不连桥，自己造弹幕，纯看效果
  python overlay.py --topmost       # 窗口置顶
  python overlay.py --shot a.png    # 只出一张图就退出（自检用）
"""
import argparse
import ctypes
import json
import os
import sys
import threading
import time
import urllib.request
from ctypes import wintypes
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render  # noqa: E402
import pet  # noqa: E402
import media  # noqa: E402

W, H = render.W, render.H
TITLE = "zuige大肥鱼直播画面"

# 有动作素材就按它的帧率重画（pet.FPS 默认 24）；没有就退回「只在变化时重画」。
# 下限原来卡在 50ms，等于把 24fps 强行砍成 20fps —— 改成 33ms 才允许跑到 30fps。
# 实际节奏由 SetTimer 的精度决定（约 15.6ms 一档，42ms 会落在 31/47 之间）。
ANIM = pet.available()
TICK_MS = max(33, int(round(1000.0 / pet.FPS))) if ANIM else 100

# 礼物媒体（视频/GIF）要 15fps 才不卡。只在真有素材在播时把节拍调到这么快，
# 播完立刻退回 TICK_MS —— 空闲时还是「秒数跳了才画」，CPU 照样是 0。
MEDIA_FPS = 15
MEDIA_TICK = max(50, int(round(1000.0 / MEDIA_FPS)))  # 66ms

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

WS_POPUP, WS_VISIBLE, WS_SYSMENU = 0x80000000, 0x10000000, 0x00080000
WS_EX_TOPMOST, WS_EX_APPWINDOW = 0x00000008, 0x00040000
SW_SHOW, SW_HIDE = 5, 0
WM_DESTROY, WM_PAINT, WM_TIMER, WM_KEYDOWN, WM_ERASEBKGND = 0x0002, 0x000F, 0x0113, 0x0100, 0x0014
WM_LBUTTONDBLCLK = 0x0203
VK_ESCAPE = 0x1B
SRCCOPY = 0x00CC0020
BI_RGB = 0
DIB_RGB_COLORS, DIB_SECT_V5 = 0, 0


# ------------------------------------------------------------------ 结构体
class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT), ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH), ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HICON),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class PAINTSTRUCT(ctypes.Structure):
    _fields_ = [
        ("hdc", wintypes.HDC), ("fErase", wintypes.BOOL),
        ("rcPaint", wintypes.RECT), ("fRestore", wintypes.BOOL),
        ("fIncUpdate", wintypes.BOOL), ("rgbReserved", ctypes.c_byte * 32),
    ]


user32.DefWindowProcW.restype = LRESULT
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
]
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.BeginPaint.restype = wintypes.HDC
user32.BeginPaint.argtypes = [wintypes.HWND, ctypes.POINTER(PAINTSTRUCT)]
user32.EndPaint.argtypes = [wintypes.HWND, ctypes.POINTER(PAINTSTRUCT)]
user32.InvalidateRect.argtypes = [wintypes.HWND, wintypes.LPVOID, wintypes.BOOL]
user32.SetTimer.restype = wintypes.UINT
user32.SetTimer.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.LPVOID]

gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.CreateDIBSection.argtypes = [
    wintypes.HDC, ctypes.POINTER(BITMAPINFOHEADER), wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD,
]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.BitBlt.argtypes = [
    wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD,
]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
user32.LoadCursorW.restype = wintypes.HANDLE
user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.UpdateWindow.argtypes = [wintypes.HWND]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
gdi32.DeleteObject.restype = wintypes.BOOL
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.restype = wintypes.BOOL
gdi32.DeleteDC.argtypes = [wintypes.HDC]


# ------------------------------------------------------------------ 状态
class State:
    """后台线程往里写，UI 线程读；整包替换，不加锁也不会读到半个状态"""

    def __init__(self, name="zuige大肥鱼"):
        self.t0 = time.time()
        self.data = {
            "name": name, "state": "idle", "stateText": "直播中",
            "online": 0, "sec": 0, "chat": 0, "gift": 0, "replied": 0,
            "token": 0, "songs": [], "danmaku": [], "subtitle": None,
            "mood": "idle", "moodAt": time.time() * 1000,
            # 礼物档位媒体（2026-10-27）。桥每次 /state.json 都带这一段，
            # render.draw_computer 靠它决定屏幕上播什么。空字典 = 待机。
            "media": {},
        }
        self.ver = 0
        self.alive = False  # 桥连上了没
        self.polled = False  # 有没有真的去拉过一次（selftest/shot 这种不走轮询的不算）

    def update(self, d):
        changed = False
        for k in ("online", "chat", "gift", "replied", "token", "state",
                  "stateText", "songs", "queue", "danmaku", "subtitle", "name",
                  "mood", "moodAt", "music", "live", "media"):
            if k in d and d[k] != self.data.get(k):
                self.data[k] = d[k]
                changed = True
        if changed:
            self.ver += 1

    def snapshot(self):
        d = dict(self.data)
        d["sec"] = int(time.time() - self.t0)
        if self.data.get("subtitle"):
            d["state"] = "busy"
        # 桥没连上时把状态文字换掉 —— 屏幕上直接看得出来，不用去翻黑窗口。
        # 画面只负责画，没有桥就没有数据源，这时候写「直播中」是假的。
        # （polled 是为了放过 --selftest / --shot 这种不轮询的模式。）
        if self.polled and not self.alive:
            d["stateText"] = "未连上弹幕桥"
            d["state"] = "idle"
        return d


_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({})  # 本机地址不能走系统代理，否则连不上
)


def poll_bridge(url, st, stop):
    warned = False
    while not stop.is_set():
        try:
            # 带上这个头，桥就知道「画面真的在拉数据」—— DSH 设置页靠它显示画面状态，
            # 比查进程靠谱（手工双击 open-overlay.cmd 起的也算数）。
            req = urllib.request.Request(url + "/state.json", headers={"x-dafeiyu-overlay": "1"})
            with _opener.open(req, timeout=2.5) as r:
                d = json.loads(r.read().decode("utf-8"))
            if not st.alive:
                print(f"  已连上弹幕桥 {url}  (demo={d.get('demo')} rid={d.get('rid') or '-'})")
            st.alive = True
            warned = False
            st.update(d)
        except Exception as e:
            if not warned:
                warned = True
                print(f"  连不上弹幕桥 {url}（{type(e).__name__}）—— 画面先空着跑。")
                print("  要弹幕上屏：先双击 start.cmd（黑窗口里开始滚弹幕），等它起来就行。")
                print("  这个窗口不用关，桥一起来它会自己接上。")
            st.alive = False
        st.polled = True
        stop.wait(0.4)


DEMO_LINES = [
    ("阿伟", "这歌真的好听", ""),
    ("momo", "主播今天状态不错啊", ""),
    ("夜色", "送出「小心心」", "gift"),
    ("小蒋", "这是 AI 吗 好像真人", ""),
    ("路人甲", "点歌：孤勇者", ""),
    ("枫", "这段我循环三遍了", ""),
    ("K", "送出「抖音一号」", "gift"),
    ("阿七", "关注了 明天还来", ""),
]
DEMO_SUBS = [
    "刚刷到一条修键盘的，居然把轴拆开一个个洗",
    "有人问这首歌叫什么，是《晴天》啦",
    "谢谢夜色的小心心，比个心给你",
    None,
    None,
]


def demo_feed(st, stop):
    import random
    st.data["songs"] = ["晴天", "海阔天空", "鱼仔"]
    st.data["queue"] = {"total": 12, "why": ""}
    st.data["online"] = 20
    st.update({})
    i = 0
    while not stop.is_set():
        u, t, k = DEMO_LINES[i % len(DEMO_LINES)]
        st.data["danmaku"] = (st.data["danmaku"] + [{"user": u, "text": t, "kind": k}])[-7:]
        if k == "gift":
            st.data["gift"] += 1
        else:
            st.data["chat"] += 1
            st.data["replied"] += 1
        st.data["online"] = max(3, st.data["online"] + random.choice((-1, 0, 1, 1)))
        st.data["token"] = max(0.0, 81.31 - i * 0.37)
        st.data["subtitle"] = DEMO_SUBS[i % len(DEMO_SUBS)]
        st.ver += 1
        i += 1
        stop.wait(1.6 + random.random() * 1.5)


# ------------------------------------------------------------------ 窗口
class Overlay:
    def __init__(self, st, topmost=False, bridge=""):
        self.st = st
        self.hwnd = None
        self.hdc_mem = None
        self.bits = None
        self.drawn_ver = -1
        self.drawn_sec = -1
        self.paints = 0
        self._proc = WNDPROC(self._wndproc)  # 必须留引用，否则被 GC 掉就是空指针
        self.topmost = topmost
        self.bridge = (bridge or "").rstrip("/")
        # 礼物媒体解码器（native/media.py）。它只认 /state.json 里的 media 段，
        # seq 变了就换素材 —— 队列 / 打断 / 冷却全在桥那边算，这边不做决策。
        self.engine = media.Engine()
        self.media_busy = False
        self.media_anim = False
        self.tick_ms = 0

    # ---- 建窗 + 位图 ----
    def create(self):
        user32.SetProcessDPIAware()
        hinst = kernel32.GetModuleHandleW(None)
        cls = "DafeiyuOverlay"
        wc = WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
        wc.style = 0x0020 | 0x0002  # CS_OWNDC | CS_HREDRAW
        wc.lpfnWndProc = self._proc
        wc.hInstance = hinst
        wc.hCursor = user32.LoadCursorW(None, ctypes.c_wchar_p(32512))
        wc.hbrBackground = None
        wc.lpszClassName = cls
        if not user32.RegisterClassExW(ctypes.byref(wc)):
            err = ctypes.get_last_error()
            if err != 1410:  # 类已注册
                raise ctypes.WinError(err)

        ex = WS_EX_APPWINDOW | (WS_EX_TOPMOST if self.topmost else 0)
        self.hwnd = user32.CreateWindowExW(
            ex, cls, TITLE, WS_POPUP | WS_VISIBLE,
            0, 0, W, H, None, None, hinst, None,
        )
        if not self.hwnd:
            raise ctypes.WinError(ctypes.get_last_error())

        hdc_scr = user32.GetDC(None)
        self.hdc_mem = gdi32.CreateCompatibleDC(hdc_scr)
        user32.ReleaseDC(None, hdc_scr)

        bi = BITMAPINFOHEADER()
        bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.biWidth = W
        bi.biHeight = -H  # 负值 = 自上而下，跟 PIL 的行序一致
        bi.biPlanes = 1
        bi.biBitCount = 32
        bi.biCompression = BI_RGB
        pbits = ctypes.c_void_p()
        hbm = gdi32.CreateDIBSection(
            self.hdc_mem, ctypes.byref(bi), DIB_RGB_COLORS, ctypes.byref(pbits), None, 0
        )
        if not hbm:
            raise ctypes.WinError(ctypes.get_last_error())
        self.bits = pbits
        gdi32.SelectObject(self.hdc_mem, hbm)
        user32.ShowWindow(self.hwnd, SW_SHOW)
        user32.UpdateWindow(self.hwnd)

    # ---- 礼物媒体：把桥的状态喂给解码器 ----
    def _pump_media(self, st):
        """返回 True = 这一拍必须重画（有素材在播，或者刚换/刚结束）。

        决策全在桥那边，这里只做三件事：对齐 seq、拿一帧、播完了回报。
        """
        med = st.get("media") or {}
        try:
            switched = self.engine.sync(med, (render.SCR_W, render.SCR_H))
        except Exception as e:  # noqa: BLE001
            # 解码器自己出错不该把画面拖死 —— 记下来，屏幕上会写原因
            self.engine.error = f"{type(e).__name__}: {e}"
            switched = False

        if self.engine.seq is not None:
            try:
                done = self.engine.finished()
            except Exception:  # noqa: BLE001
                done = False
            if done:
                seq = self.engine.seq
                self.engine.close()
                self.media_busy = False
                self.media_anim = False
                self._report_done(seq)
                return True

        self.media_busy = self.engine.seq is not None
        # 只有视频 / 动图 / 音频才需要每拍重画；一张静态图不用抢 15fps。
        self.media_anim = self.engine.animated
        return switched or self.media_anim

    def _report_done(self, seq):
        """告诉桥「这一份放完了」，让它把队列里下一个顶上来。

        必须异步：mciSendString / ffmpeg 已经够占事了，不能再用一个 2 秒超时的
        HTTP 请求卡住窗口消息循环 —— 卡住就是画面冻住。
        """
        if not self.bridge or seq is None:
            return
        url = f"{self.bridge}/media/done?seq={int(seq)}&why={quote('画面播完')}"

        def go():
            try:
                with _opener.open(url, timeout=2) as r:
                    r.read()
            except Exception:  # noqa: BLE001
                pass  # 桥不在就等它自己的超时兜底，不影响画面

        threading.Thread(target=go, daemon=True).start()

    def _retick(self, busy):
        """按「有没有素材在播」调窗口定时器的节拍。SetTimer 同 id 会直接替换。"""
        want = MEDIA_TICK if busy else TICK_MS
        if want == self.tick_ms:
            return
        self.tick_ms = want
        if self.hwnd:
            user32.SetTimer(self.hwnd, 1, want, None)

    # ---- 画一帧 ----
    def paint_frame(self, st=None):
        st = st or self.st.snapshot()
        self._pump_media(st)  # 对齐 seq / 拿帧 / 播完回报（结果存在 self.media_anim）
        # 解码器拿一帧塞进 st —— render 只负责贴，不认识 ffmpeg / MCI
        st = dict(st)
        st["_media_frame"] = self.engine.frame((render.SCR_W, render.SCR_H))
        st["_media_error"] = self.engine.error
        img = render.compose(st)
        buf = img.tobytes("raw", "BGRX")  # 32bpp DIB 的内存序就是 BGRX
        ctypes.memmove(self.bits, buf, len(buf))
        hdc = user32.GetDC(self.hwnd)
        gdi32.BitBlt(hdc, 0, 0, W, H, self.hdc_mem, 0, 0, SRCCOPY)
        user32.ReleaseDC(self.hwnd, hdc)
        self.drawn_ver = self.st.ver
        self.drawn_sec = int(time.time())
        self.paints += 1
        self._retick(self.media_anim)

    # ---- 消息循环 ----
    def _wndproc(self, hwnd, msg, wp, lp):
        if msg == WM_TIMER:
            if wp == 2:
                if self.capture_path:
                    self.capture(self.capture_path)
                user32.PostQuitMessage(0)
                return 0
            sec = int(time.time())
            # 动起来之后每一拍都要重画（动作帧 / 视频帧在变）；没素材时还是老规矩：
            # 状态变了或者秒数跳了才画，空闲时 CPU 是 0。
            if ANIM or self.media_anim or self.st.ver != self.drawn_ver or sec != self.drawn_sec:
                self.paint_frame()
            return 0
        if msg == WM_PAINT:
            ps = PAINTSTRUCT()
            hdc = user32.BeginPaint(hwnd, ctypes.byref(ps))
            if self.bits and self.hdc_mem:
                gdi32.BitBlt(hdc, 0, 0, W, H, self.hdc_mem, 0, 0, SRCCOPY)
            user32.EndPaint(hwnd, ctypes.byref(ps))
            return 0
        if msg == WM_ERASEBKGND:
            return 1
        if msg == WM_KEYDOWN and wp == VK_ESCAPE:
            user32.DestroyWindow(hwnd)
            return 0
        if msg == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wp, lp)

    def run(self, quit_after=None, capture_path=None):
        self.capture_path = capture_path
        self.create()
        self.paint_frame()
        # 首帧画完才知道该用多快的节拍（有素材在播就是 66ms）
        user32.SetTimer(self.hwnd, 1, self.tick_ms or TICK_MS, None)
        if quit_after:
            user32.SetTimer(self.hwnd, 2, int(quit_after * 1000), None)  # 自检用：到点自己退出
        msg = wintypes.MSG()
        try:
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        finally:
            self.engine.close()  # 别把 ffmpeg 子进程留在后台
        self.paints -= 1  # 首帧不算在计时窗口里

    def capture(self, out_png):
        """用 PrintWindow 把窗口的真实合成内容抓回来存图。
        它能抓到，直播伴侣的「窗口捕捉」就也能看到。"""
        from PIL import Image
        hdc_dst = gdi32.CreateCompatibleDC(None)
        bi = BITMAPINFOHEADER()
        bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.biWidth, bi.biHeight = W, -H
        bi.biPlanes, bi.biBitCount, bi.biCompression = 1, 32, BI_RGB
        pbits = ctypes.c_void_p()
        hbm = gdi32.CreateDIBSection(hdc_dst, ctypes.byref(bi), DIB_RGB_COLORS,
                                     ctypes.byref(pbits), None, 0)
        gdi32.SelectObject(hdc_dst, hbm)
        gdi32.GdiFlush()
        ok = user32.PrintWindow(self.hwnd, hdc_dst, 2)  # 2 = PW_RENDERFULLCONTENT
        gdi32.GdiFlush()
        img = Image.frombytes("RGB", (W, H), ctypes.string_at(pbits, W * H * 4), "raw", "BGRX")
        img.save(out_png)
        gdi32.DeleteObject(hbm)
        gdi32.DeleteDC(hdc_dst)
        print(f"  已抓图 {out_png}（PrintWindow={ok}）")
        return img

    def selftest(self, out_png):
        """建真窗口 → 画一帧 → 抓回来，验证整条 Win32 链路"""
        self.create()
        self.paint_frame()
        img = self.capture(out_png)
        user32.DestroyWindow(self.hwnd)
        print(f"  中心像素={img.getpixel((W // 2, H // 2))}")
        return img


# -------------------------------------------------------------------- main
def hide_own_console():
    """把「自己那块控制台」藏掉（2026-10-27 修「怎么出现了一个空白的终端」）。

    谁开的控制台已经查清了：DSH 插件用 python.exe 直接 spawn overlay.py，
    python.exe 是控制台程序 → Windows 给分配一个终端（这台机器默认终端是
    Windows Terminal），而它的 stdout 被插件重定向进了 zhibo-overlay.log，
    于是屏幕上多出一个**一个字都没有**的终端窗口，看着像卡死了。

    正解是插件那边改用 pythonw.exe（config.json 的 zhiboPython 已改）。这里是
    兜底：万一又被 python.exe 拉起来（手动双击、旧配置、别人 fork 的脚本），
    至少它自己会把窗口收起来，不会一直挂在那儿碍事。

    只藏自己的：GetConsoleWindow() 返回的就是本进程附着的那个控制台窗口，
    别的终端一概不碰。没有控制台（pythonw）时返回 0，直接跳过。

    **只在输出被重定向时藏**。手动 `python native\\overlay.py` 跑的时候 stdout
    是接在终端上的（isatty），那说明人就坐在终端前看日志，藏掉等于把他眼前的
    东西抢走，不能藏。
    """
    if sys.stdout is not None and sys.stdout.isatty():
        return  # 人在终端前看着，别动
    try:
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE
    except Exception:
        pass  # 藏不掉不算错，画面照跑


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--bridge", default="http://127.0.0.1:18081")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--topmost", action="store_true")
    ap.add_argument("--shot", default=None, help="只渲染一张图存下来然后退出")
    ap.add_argument("--selftest", default=None, help="建真窗口画一帧再抓回来，验证 Win32 链路")
    ap.add_argument("--soak", type=float, default=0, help="空跑 N 秒测 CPU（不连数据源）")
    ap.add_argument("--capture", default=None, help="配 --soak：结束时把窗口内容抓成 PNG")
    ap.add_argument("--media", default=None,
                    help="配 --shot：假装这个文件正在播（不连桥也能验电脑展示区）")
    ap.add_argument("--name", default="zuige大肥鱼")
    a = ap.parse_args()

    st = State(a.name)

    if a.selftest:
        st.data["songs"] = ["晴天", "海阔天空"]
        st.data["queue"] = {"total": 12, "why": ""}
        st.data.update({"online": 20, "chat": 79, "gift": 23, "replied": 12,
                        "token": 81.31,
                        "subtitle": "刚刷到一条修键盘的，居然把轴拆开一个个洗"})
        st.data["danmaku"] = [{"user": "阿伟", "text": "这歌真的好听", "kind": ""},
                              {"user": "夜色", "text": "送出「小心心」", "kind": "gift"}]
        Overlay(st, a.topmost, a.bridge).selftest(a.selftest)
        return 0

    if a.shot:
        if a.demo:
            st.data["songs"] = ["晴天", "海阔天空"]
            st.data["queue"] = {"total": 12, "why": ""}
            st.data.update({"online": 20, "chat": 79, "gift": 23, "replied": 12,
                            "token": 81.31, "sec": 754,
                            "subtitle": "刚刷到一条修键盘的，居然把轴拆开一个个洗"})
            st.data["danmaku"] = [{"user": "阿伟", "text": "这歌真的好听", "kind": ""},
                                  {"user": "夜色", "text": "送出「小心心」", "kind": "gift"}]
        # --media：伪造一段 media 状态，把电脑展示区真跑一遍再截图
        fake = None
        if a.media:
            p = os.path.abspath(a.media)
            base = os.path.basename(p)
            ext = os.path.splitext(p)[1].lower()
            kind = ("video" if ext in media.VIDEO_EXT else
                    "audio" if ext in media.AUDIO_EXT else
                    "anim" if ext in media.ANIM_EXT else "image")
            # 档位从文件名开头推（跟桥的规则一致），别写死 —— 否则截图里
            # 会出现「档位2 · 4-嘉年华.gif」这种自相矛盾的画面。
            # 0 也要算进去 —— 少了它，`0-梁圣巡演.mp4` 在截图里会被标成「档位1」，
            # 跟真实运行（闲时）对不上，看截图的人会以为桥判错了档。
            tier = int(base[0]) if base[:1].isdigit() else 1
            # 档位 0 = 闲时/点播，不是礼物档，所以没有「送了什么」——
            # 直接查字典会 KeyError:0（.isdigit() 那行改完就踩到了）。
            gift_name = {1: "小心心", 2: "棒棒糖", 3: "跑车", 4: "嘉年华"}.get(tier, "")
            cur = {"seq": 1, "file": p, "name": base, "kind": kind,
                   "tier": tier, "user": "阿伟" if tier else "",
                   "gift": gift_name,
                   "volume": 1.0, "loop": False, "maxMs": 15000,
                   "at": int(time.time() * 1000)}
            st.data["media"] = {"on": True, "idle": "standby", "cur": cur,
                                "counts": {1: 1, 2: 1, 3: 1, 4: 1}}
            fake = media.Engine()
            fake.sync(st.data["media"], (render.SCR_W, render.SCR_H))
        snap = st.snapshot()
        if fake:
            snap["_media_frame"] = fake.frame((render.SCR_W, render.SCR_H))
            snap["_media_error"] = fake.error
        img = render.compose(snap)
        img.save(a.shot)
        if fake:
            fake.close()
        print(f"已存 {a.shot}")
        return 0

    # 单实例：不小心双击两次别开两个窗口
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    mtx = kernel32.CreateMutexW(None, True, "Global\\DafeiyuOverlay")
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        print("已经有一个画面在跑了。要重开先关掉那个窗口。")
        return 1

    stop = threading.Event()
    if a.soak:
        st.data.update({"online": 20, "chat": 79, "gift": 23, "replied": 12, "token": 81.31,
                        "songs": [["只因你太美", "蔡徐坤"]], "sec": 0,
                        "danmaku": [{"user": "阿伟", "text": "这歌真的好听", "kind": ""}]})
        st.ver += 1
        ov = Overlay(st, a.topmost, a.bridge)
        feed = demo_feed if a.demo else (lambda s, x: poll_bridge(a.bridge, s, x))
        threading.Thread(target=feed, args=(st, stop), daemon=True).start()
        c0, w0 = time.process_time(), time.time()
        ov.run(quit_after=a.soak, capture_path=a.capture)
        wall, cpu = time.time() - w0, time.process_time() - c0
        stop.set()
        print(f"跑 {wall:.1f}s  重画 {ov.paints} 帧")
        print(f"CPU {cpu:.2f}s = 单核 {cpu/wall*100:.2f}%   折算每小时 {cpu/wall*3600:.1f}s")
        return 0

    src = "demo（自己造弹幕）" if a.demo else a.bridge
    hide_own_console()
    t = threading.Thread(
        target=demo_feed if a.demo else poll_bridge,
        args=(st, stop) if a.demo else (a.bridge, st, stop),
        daemon=True,
    )
    t.start()
    print(f"数据源：{src}")
    print(f"窗口：{TITLE}  {W}×{H}   （按 Esc 关闭）")

    try:
        Overlay(st, a.topmost, a.bridge).run()
    finally:
        stop.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
