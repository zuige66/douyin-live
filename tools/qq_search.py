# -*- coding: utf-8 -*-
"""qq_search.py —— 让大肥鱼真的去 QQ 音乐里「搜歌 → 播放」。

============================================================================
为什么需要它
============================================================================
QQ 音乐 PC 版**没有任何**可编程接口：
  · 没有 qqmusic:// 这类 URL 协议（整个安装目录 grep 过，只有文件关联）
  · 本地 HTTP 端口不开放（试过的全 404）
  · 播放列表数据库 qmlist64.db 是加密的
  · SMTC 只有 next / prev，没有「跳到第 N 首」
所以「点歌」原来只能在**用户自己的播放列表**里一首首 next 翻 ——
歌单里没有的歌永远点不到，观众点了没反应。

唯一的出路是 UI 自动化：把 QQ 音乐窗口置前 → 点搜索框 → 键盘输入歌名 →
回车 → 点结果页的「播放」。这条链路在 2026-10-27 实测跑通：
    搜索前 SMTC「我爱过你 - Eric周兴哲」→ 搜「最佳损友」→ 点播放
    → SMTC 变成「最佳损友 - 陈奕迅」

============================================================================
它有什么副作用（必须知道）
============================================================================
1. **会抢焦点**：要把 QQ 音乐窗口置前才能输入，直播间主人屏幕上会闪一下。
2. **会替换播放队列**：点的是搜索结果页的「播放全部」，当前播放列表会被
   搜索结果顶掉。所以点歌成功后桥会把歌单快照清空重抓。
3. 需要 QQ 音乐是**登录状态**，否则搜出来的歌可能只有试听。

用法：
    python tools/qq_search.py --name 最佳损友
    python tools/qq_search.py --name 最佳损友 --dry    # 只搜不播（排查用）
输出：一行 JSON（UTF-8）
    {"ok":true,"searched":"最佳损友","clicked":true,"ms":6200}
============================================================================
"""
import sys
import io
import os
import json
import time
import ctypes
import subprocess

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# 高 DPI 感知必须在 import uiautomation 之前设置，
# 否则控件坐标和鼠标坐标不是同一个坐标系，点击会落在空处（实测踩过）。
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

QQ_EXE = os.environ.get("ZY_QQ_EXE") or r"D:\download\QQMusic\QQMusic.exe"
WINDOW_CLASS = "TXGuiFoundation"
WAIT_WINDOW = float(os.environ.get("ZY_QQ_WAIT", "25"))
user32 = ctypes.windll.user32


def out(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def find_search_box(auto, w, tries=3):
    """拿搜索框。找不到就点「后退」往回退。

    🔴 实测（2026-10-27）：点过「播放」之后 QQ 音乐会跳到**歌曲详情页**，
    那一页的顶栏没有搜索框，UIA 树也整个变空（只剩无名 Pane）。
    点一下左上角「后退」回到搜索页/首页，搜索框就回来了。
    所以要退几次试探，别一上来就报「版本界面可能变了」。
    """
    e = w.EditControl(searchDepth=14)
    if e.Exists(1.2):
        return e
    for _ in range(tries):
        b = w.ButtonControl(Name="后退", searchDepth=14)
        if not b.Exists(0.8):
            break
        try:
            b.Click(simulateMove=False)
        except Exception:
            break
        time.sleep(1.6)
        e = w.EditControl(searchDepth=14)
        if e.Exists(1.2):
            return e
    return None


def find_window(auto):
    """找 QQ 音乐主窗口。可能同时存在歌词窗/迷你窗，挑**带搜索框**的那个。"""
    cands = []
    for w in auto.GetRootControl().GetChildren():
        try:
            if WINDOW_CLASS in (w.ClassName or ""):
                cands.append(w)
        except Exception:
            pass
    if not cands:
        return None
    for w in cands:
        try:
            if w.EditControl(searchDepth=14).Exists(0.6):
                return w
        except Exception:
            pass
    return cands[0]


def ensure_running(auto):
    """没开就拉起来（点歌总得有个播放器）。已经开着就等窗口出现。"""
    w = find_window(auto)
    if w is not None:
        return w, False
    if not os.path.exists(QQ_EXE):
        raise RuntimeError(f"找不到 QQ 音乐：{QQ_EXE}（用环境变量 ZY_QQ_EXE 指定）")
    try:
        subprocess.Popen([QQ_EXE], close_fds=True)
    except Exception as e:
        raise RuntimeError(f"拉不起来 QQ 音乐：{e}")
    t0 = time.time()
    while time.time() - t0 < WAIT_WINDOW:
        time.sleep(1.0)
        w = find_window(auto)
        if w is not None:
            return w, True
    raise RuntimeError(f"QQ 音乐起了但 {int(WAIT_WINDOW)} 秒内没看到窗口")


def bring_onscreen(auto, w):
    """把窗口挪进屏幕。

    🔴 实测：QQ 音乐会把窗口停在屏幕外（rect 的 y=1883，而屏幕只有 2080 高），
    这时控件坐标也在屏幕外，鼠标点上去什么都没发生 —— 现象就是
    「点了播放按钮但歌没变」。必须先 SetWindowPos 挪回来。
    """
    if w.IsMinimize():
        w.Restore()
        time.sleep(0.6)
    hwnd = w.NativeWindowHandle
    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    W = min(1600, max(900, sw - 80))
    H = min(1000, max(600, sh - 80))
    SWP_NOZORDER, SWP_SHOWWINDOW = 0x0004, 0x0040
    user32.SetWindowPos(hwnd, 0, 40, 40, W, H, SWP_NOZORDER | SWP_SHOWWINDOW)
    time.sleep(0.7)
    r = w.BoundingRectangle
    # 有的版本会把自己的窗口位置又抢回去（实测挪完再点播放，窗口又跑回屏幕外）。
    # 挪不动就直接最大化 —— 最大化的窗口一定在屏幕里。
    if r.top >= sh or r.bottom <= 0 or r.left >= sw or r.right <= 0:
        try:
            w.Maximize()
            time.sleep(0.9)
            r = w.BoundingRectangle
        except Exception:
            pass
    return r


def find_play_button(auto, w):
    """结果页工具条上的「播放」（= 播放全部）。

    只认**完全等于「播放」**的名字：
    「播放队列」「播放列表」这些按钮名字更长，Name 精确匹配不会误伤。
    """
    for name in ("播放", "播放全部"):
        for cls in (auto.TextControl, auto.ButtonControl):
            try:
                c = cls(Name=name, searchFromControl=w, searchDepth=14)
                if c.Exists(0.8):
                    return c
            except Exception:
                pass
    return None


def main():
    name = ""
    dry = False
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--name" and i + 1 < len(args):
            name = args[i + 1]
            i += 2
        elif a.startswith("--name="):
            name = a.split("=", 1)[1]
            i += 1
        elif a == "--dry":
            dry = True
            i += 1
        else:
            i += 1
    name = (name or "").strip()
    if not name:
        out(ok=False, why="没给歌名")
        return 1

    t0 = time.time()
    try:
        import uiautomation as auto
    except Exception as e:
        out(ok=False, why=f"没装 uiautomation：{e}（pip install uiautomation）")
        return 1
    auto.SetGlobalSearchTimeout(1.2)

    try:
        w, launched = ensure_running(auto)
    except Exception as e:
        out(ok=False, why=str(e))
        return 1

    try:
        bring_onscreen(auto, w)
        w.SetActive()
        time.sleep(0.8)
    except Exception as e:
        out(ok=False, why=f"窗口置前失败：{e}")
        return 1

    edit = find_search_box(auto, w)
    if edit is None:
        out(ok=False, why="QQ 音乐里找不到搜索框（点了几次「后退」也没回去，可能界面变了）")
        return 1

    # ValuePattern 在这版 QQ 音乐里是**只读**的（SetValue 抛「尚未实现」），
    # 只能点一下再走键盘输入。
    # 而且要**重试**：点过「后退」之后焦点常常还在那个按钮上，
    # 第一次 Ctrl+A + 输入会打空，搜索框里还留着上一次的歌名。
    typed = ""
    ok_input = False
    for attempt in range(3):
        try:
            w.SetActive()
            time.sleep(0.3)
            edit.Click(simulateMove=False)
            time.sleep(0.35)
            auto.SendKeys("{Ctrl}a", waitTime=0.05)
            time.sleep(0.15)
            auto.SendKeys(name, waitTime=0.05, interval=0.04)
            time.sleep(0.45)
            typed = (edit.GetValuePattern().Value or "")
        except Exception as e:
            typed = f"<{type(e).__name__}: {e}>"
        if typed.strip() == name:
            ok_input = True
            break
        time.sleep(0.4)
    if not ok_input:
        out(ok=False, why=f"歌名没输进去（搜索框里是「{typed}」）")
        return 1

    try:
        auto.SendKeys("{Enter}", waitTime=0.1)
    except Exception as e:
        out(ok=False, why=f"回车失败：{e}")
        return 1
    time.sleep(3.2)  # 等结果页渲染；实测 2 秒内就出来了，留点余量

    if dry:
        btn = find_play_button(auto, w)
        out(ok=True, searched=name, clicked=False, dry=True,
            foundButton=bool(btn), ms=int((time.time() - t0) * 1000))
        return 0

    btn = find_play_button(auto, w)
    if btn is None:
        out(ok=False, searched=name, why="搜到了但没有「播放」按钮（可能一首都没搜到）",
            ms=int((time.time() - t0) * 1000))
        return 1

    try:
        btn.Click(simulateMove=False)
    except Exception as e:
        out(ok=False, searched=name, why=f"点播放失败：{e}")
        return 1

    time.sleep(2.0)
    out(ok=True, searched=name, clicked=True, launched=launched,
        ms=int((time.time() - t0) * 1000))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        out(ok=False, why=f"{type(e).__name__}: {e}")
        sys.exit(1)
