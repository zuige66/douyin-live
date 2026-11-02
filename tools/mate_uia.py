#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""直播伴侣 UIA 控制层 —— 不碰鼠标、不碰 SendInput。

为什么不能用鼠标：
  1) 直播伴侣主程序 manifest 是 requireAdministrator + uiAccess，进程跑在 High IL。
     中完整性进程的 SetCursorPos / SendInput 会被 UIPI 静默丢掉（返回 0，GetLastError 也是 0）。
  2) 它自带 edrAgent（抖音安全组件 5.3.3.53），把软件级输入注入 hook 掉了。

UIA 的 InvokePattern 走的是「UI Automation 提供者的默认动作」，
由目标进程自己在内部派发点击 —— 不过输入队列，不受 UIPI 限制，也不触发输入 hook。

注意：uiautomation 这个版本里**没有** `auto.ProcessName`（1.x 才有），
所以进程名一律用 Win32 QueryFullProcessImageNameW 自己取。

CLI:
    python tools/mate_uia.py windows            列出直播伴侣的顶层窗口
    python tools/mate_uia.py probe [--depth 8]  导出 UIA 树（JSON），用来找按钮名
    python tools/mate_uia.py state              读当前是否在播
    python tools/mate_uia.py start|stop [--dry] 开播 / 关播

被 mate_agent.py import 使用。
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import re
import sys
import time

try:
    import uiautomation as auto
except Exception as e:  # pragma: no cover
    sys.stderr.write("uiautomation 不可用: %r\n" % (e,))
    raise

# 进程名。exe 是「直播伴侣.exe」
PROC_NAMES = ("直播伴侣.exe", "直播伴侣")
# 兜底：万一 exe 改名了，靠窗口标题认
TITLE_HINTS = ("直播伴侣",)

# 按钮候选名。精确优先，包含次之。
START_NAMES = ("开始直播", "立即开播", "开播", "开始")
STOP_NAMES = ("结束直播", "关闭直播", "停止直播", "关播", "下播", "结束")

# 在播的旁证：只有推流时才会出现的文本
LIVE_HINTS = ("kb/s", "KB/s", "码率", "直播时长", "已播")

auto.SetGlobalSearchTimeout(2)

_k32 = ctypes.windll.kernel32
_u32 = ctypes.windll.user32
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


# ---------------------------------------------------------------- 进程名
def proc_name(pid: int) -> str:
    """QueryFullProcessImageNameW → 基名。跨 IL 也能拿到（LIMITED_INFORMATION 够）。"""
    h = _k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        sz = wt.DWORD(1024)
        if not _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(sz)):
            return ""
        return buf.value.split("\\")[-1]
    finally:
        _k32.CloseHandle(h)


def _is_target(pid: int, title: str) -> bool:
    nm = proc_name(pid)
    if nm and any(nm.lower() == p.lower() for p in PROC_NAMES):
        return True
    return any(h in (title or "") for h in TITLE_HINTS)



# ---------------------------------------------------------------- 找窗口
_EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def _enum_top() -> list[tuple]:
    """Win32 EnumWindows 全量枚举。

    不能用 auto.GetRootControl().GetChildren()：UIA 的根枚举会按完整性级别过滤，
    中等权限调用时**看不到**高权限进程的窗口（实测 15 个窗口里就是没有直播伴侣）。
    提权进程调用才全。用 EnumWindows 就没这个坑。
    """
    res = []

    @_EnumProc
    def cb(hwnd, lp):
        pid = wt.DWORD()
        _u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        res.append((int(hwnd), int(pid.value)))
        return True

    _u32.EnumWindows(cb, 0)
    return res


def _win_text(hwnd, fn, buf_len=512):
    buf = ctypes.create_unicode_buffer(buf_len)
    if fn is _u32.GetWindowTextW:
        n = _u32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 2)
        _u32.GetWindowTextW(hwnd, buf, n + 2)
    else:
        fn(hwnd, buf, buf_len)
    return buf.value


def list_windows() -> list[dict]:
    """直播伴侣的所有顶层窗口。可见、有面积的排前面。"""
    out = []
    cache: dict[int, str] = {}
    for hwnd, pid in _enum_top():
        try:
            if pid not in cache:
                cache[pid] = proc_name(pid)
            nm = cache[pid]
            title = _win_text(hwnd, _u32.GetWindowTextW)
            if not (nm and any(nm.lower() == p.lower() for p in PROC_NAMES)) and not any(
                h in title for h in TITLE_HINTS
            ):
                continue
            cls = _win_text(hwnd, _u32.GetClassNameW, 256)
            r = wt.RECT()
            _u32.GetWindowRect(hwnd, ctypes.byref(r))
            w_, h_ = int(r.right - r.left), int(r.bottom - r.top)
            out.append(
                {
                    "hwnd": hwnd,
                    "title": title,
                    "class": cls,
                    "pid": pid,
                    "proc": nm,
                    "rect": [int(r.left), int(r.top), int(r.right), int(r.bottom)],
                    "area": max(0, w_) * max(0, h_),
                    "visible": bool(_u32.IsWindowVisible(hwnd)),
                }
            )
        except Exception:
            continue
    out.sort(key=lambda x: (not x["visible"], -x["area"]))
    return out


LAST_ERRORS: list[str] = []


def ensure_visible() -> list[str]:
    """把主窗口恢复出来。

    Chromium 一旦最小化/隐藏就会**丢掉整棵无障碍树**（节点数从 400+ 掉到 9），
    这时候读到的「没有开播/关播按钮」是假的。所以读之前先恢复。
    只碰 Chrome_WidgetWin_1 + 标题为直播伴侣的窗口，不碰那些隐藏的辅助 frame。
    """
    acts = []
    for w in list_windows():
        if w["class"] != "Chrome_WidgetWin_1" or "直播伴侣" not in (w["title"] or ""):
            continue
        minimized = w["rect"][0] <= -30000 or w["rect"][1] <= -30000
        if not w["visible"] or minimized:
            try:
                _u32.ShowWindow(w["hwnd"], 9)  # SW_RESTORE
                acts.append("restore hwnd=%s" % w["hwnd"])
            except Exception:
                pass
    if acts:
        time.sleep(0.6)  # 等 Chromium 把树重建出来
    return acts


def roots():
    """所有可见、有面积的窗口的 Control（UIA 树可能分散在多个窗口里）。"""
    LAST_ERRORS.clear()
    res = []
    for w in list_windows():
        if w["area"] <= 0 or not w["visible"]:
            continue
        if w["rect"][0] <= -30000 or w["rect"][1] <= -30000:
            continue
        try:
            c = auto.ControlFromHandle(w["hwnd"])
            if c is not None:
                res.append((c, w))
            else:
                LAST_ERRORS.append("hwnd=%s ControlFromHandle 返回 None" % w["hwnd"])
        except Exception as e:
            LAST_ERRORS.append("hwnd=%s %r" % (w["hwnd"], e))
            continue
    return res


def find_main():
    rs = roots()
    return rs[0] if rs else (None, None)


# ---------------------------------------------------------------- 导树
def _rect(c) -> list[int]:
    try:
        r = c.BoundingRectangle
        return [int(r.left), int(r.top), int(r.right), int(r.bottom)]
    except Exception:
        return []


def _patterns(c) -> list[str]:
    got = []
    for key, pid in (
        ("invoke", auto.PatternId.InvokePattern),
        ("legacy", auto.PatternId.LegacyIAccessiblePattern),
        ("toggle", auto.PatternId.TogglePattern),
        ("selectitem", auto.PatternId.SelectionItemPattern),
        ("expand", auto.PatternId.ExpandCollapsePattern),
    ):
        try:
            if c.GetPattern(pid):
                got.append(key)
        except Exception:
            pass
    return got


def node(c, depth: int, with_patterns: bool = True) -> dict:
    d = {
        "type": c.ControlTypeName,
        "name": (c.Name or "")[:120],
        "cls": (c.ClassName or "")[:60],
        "aid": (c.AutomationId or "")[:60],
        "rect": _rect(c),
        "off": bool(c.IsOffscreen),
        "depth": depth,
    }
    if with_patterns:
        d["patterns"] = _patterns(c)
    return d


def walk(ctrl, depth: int, max_depth: int, max_nodes: int, out: list, with_patterns=True):
    """深度优先。Chromium 的树很大，深度和节点数都封顶。"""
    stack = [(ctrl, depth)]
    while stack and len(out) < max_nodes:
        cur, d = stack.pop()
        try:
            out.append(node(cur, d, with_patterns))
        except Exception:
            continue
        if d >= max_depth:
            continue
        try:
            kids = cur.GetChildren()
        except Exception:
            continue
        for k in reversed(kids):
            if len(out) >= max_nodes:
                break
            stack.append((k, d + 1))


def probe(max_depth: int = 8, max_nodes: int = 1500) -> dict:
    ensure_visible()
    rs = roots()
    if not rs:
        return {
            "ok": False,
            "reason": "没有找到直播伴侣窗口（是不是没启动？）" if not list_windows() else "窗口在但 UIA 树取不到",
            "errors": list(LAST_ERRORS),
            "windows": list_windows(),
        }
    nodes: list[dict] = []
    per_window = max(200, max_nodes // len(rs))
    for ctrl, _ in rs:
        walk(ctrl, 0, max_depth, per_window, nodes)
    return {
        "ok": True,
        "window": rs[0][1],
        "windows": [w for _, w in rs],
        "nodeCount": len(nodes),
        "truncated": len(nodes) >= max_nodes,
        "nodes": nodes,
        "candidates": find_candidates(),
    }


# ---------------------------------------------------------------- 找按钮
# 关播按钮的真实名字带直播时长前缀：「00:02:28 关播」。这是最强的信号。
_STOP_BTN_RE = re.compile(r"\d{1,2}:\d{2}(?::\d{2})?\s*关播")


def _bonus(name: str, kind: str) -> int:
    """在 _score 之上再修一把，把「像按钮的」和「只是文案的」分开。"""
    b = 0
    if kind == "stop":
        if _STOP_BTN_RE.search(name):
            b += 400          # 真的关播按钮
        if "已结束" in name or "？" in name or "吗" in name:
            b -= 300          # 「直播已结束」提示、「确认要结束当前直播吗？」标题
    else:
        if name.strip() == "开始直播":
            b += 400
    return b


def _score(name: str, table: tuple) -> int:
    """精确命中 1000 分，包含 500 分往下 —— 免得「开始」抢走「开始直播」。"""
    if not name:
        return 0
    n = name.strip()
    for i, t in enumerate(table):
        if n == t:
            return 1000 - i
    for i, t in enumerate(table):
        if t in n:
            return 500 - i * 10 - min(len(n), 40)
    return 0


def find_candidates() -> dict:
    res = {"start": [], "stop": []}
    nodes: list[dict] = []
    for ctrl, _ in roots():
        walk(ctrl, 0, 10, 4000, nodes)
    for n in nodes:
        for kind, table in (("start", START_NAMES), ("stop", STOP_NAMES)):
            s = _score(n["name"], table) + _bonus(n["name"], kind)
            if s > 0:
                res[kind].append({**n, "score": s})
    for kind in res:
        res[kind].sort(key=lambda x: -x["score"])
        res[kind] = res[kind][:8]
    return res


def _elements_for(kind: str):
    """返回按分数排序的 Control 列表（跨所有窗口）。"""
    table = START_NAMES if kind == "start" else STOP_NAMES
    scored = []

    def rec(c, d):
        if d > 10:
            return
        try:
            nm = c.Name or ""
            s = _score(nm, table) + _bonus(nm, kind)
            if kind == "stop" and ("已结束" in nm or "？" in nm or "吗" in nm):
                s = 0   # 「直播已结束」提示、「确认要结束当前直播吗？」标题，都不是按钮
        except Exception:
            s = 0
        if s > 0:
            # 有面积的优先：Chromium 会塞一堆 0 尺寸的隐藏节点，名字可能一模一样
            try:
                r = c.BoundingRectangle
                if int(r.right - r.left) * int(r.bottom - r.top) > 0:
                    s += 100
            except Exception:
                pass
            scored.append((s, c))
        try:
            kids = c.GetChildren()
        except Exception:
            return
        for k in kids:
            rec(k, d + 1)

    for ctrl, _ in roots():
        rec(ctrl, 0)
    scored.sort(key=lambda x: -x[0])
    return [c for _, c in scored]


# ---------------------------------------------------------------- 真实鼠标（兜底）
# 只给「UIA 模式点不动」的控件用（CEF 自绘下拉之类）。
# 前提：本进程必须是提权的 —— 中完整性进程的 SendInput 会被 UIPI 静默丢弃
# （返回 0，GetLastError 也是 0，查不出原因）。
_SM_XV, _SM_YV, _SM_CXV, _SM_CYV = 76, 77, 78, 79   # 虚拟桌面左上角 / 宽高
_MF_MOVE, _MF_LEFTDOWN, _MF_LEFTUP = 0x0001, 0x0002, 0x0004
_MF_ABSOLUTE, _MF_VIRTUALDESK = 0x8000, 0x4000
_dpi_done = False


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
        ("dwFlags", wt.DWORD), ("time", wt.DWORD),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("mi", _MOUSEINPUT)]


def _ensure_dpi():
    """必须先把进程设成 DPI 感知，否则 GetSystemMetrics 给的是缩放后的逻辑像素，
    换算成 65535 归一化坐标会整体偏掉（表现是「点是点了，但点在别处」）。"""
    global _dpi_done
    if _dpi_done:
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:  # noqa: BLE001
            pass
    _dpi_done = True


def click_at(x: int, y: int, double: bool = False) -> dict:
    """在屏幕坐标 (x, y) 上真点一下。返回 ok + 换算后的虚拟桌面尺寸（排查用）。"""
    _ensure_dpi()
    vx = _u32.GetSystemMetrics(_SM_XV)
    vy = _u32.GetSystemMetrics(_SM_YV)
    vw = _u32.GetSystemMetrics(_SM_CXV) or 1
    vh = _u32.GetSystemMetrics(_SM_CYV) or 1
    ax = int(round((x - vx) * 65535.0 / max(1, vw - 1)))
    ay = int(round((y - vy) * 65535.0 / max(1, vh - 1)))

    try:
        _u32.SendInput.argtypes = [ctypes.c_uint, ctypes.c_void_p, ctypes.c_int]
        _u32.SendInput.restype = ctypes.c_uint
    except Exception:  # noqa: BLE001
        pass

    def send(flags: int) -> bool:
        inp = _INPUT(type=0, mi=_MOUSEINPUT(dx=ax, dy=ay, mouseData=0,
                                            dwFlags=flags, time=0, dwExtraInfo=None))
        return _u32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT)) == 1

    base = _MF_MOVE | _MF_ABSOLUTE | _MF_VIRTUALDESK
    ok = send(base | _MF_LEFTDOWN)
    time.sleep(0.06)
    ok = send(base | _MF_LEFTUP) and ok
    if double:
        time.sleep(0.09)
        send(base | _MF_LEFTDOWN)
        time.sleep(0.06)
        send(base | _MF_LEFTUP)
    return {"ok": bool(ok), "at": [x, y], "norm": [ax, ay],
            "virtualDesktop": [vx, vy, vw, vh]}


def expand_named(name: str, exact: bool = True) -> dict:
    """只试 ExpandCollapsePattern（下拉框专用）。

    CEF 自绘的下拉只有 invoke/legacy 模式，Invoke() 只聚焦不展开；
    但有些版本会真的实现 ExpandCollapse，那就得单独走这个。
    """
    for c in _all_nodes():
        try:
            if ((c.Name or "").strip() == name) if exact else (name in (c.Name or "")):
                p = c.GetPattern(auto.PatternId.ExpandCollapsePattern)
                if not p:
                    return {"ok": False, "reason": "控件找到了，但没有 ExpandCollapse 模式",
                            "picked": node(c, 0)}
                p.Expand()
                return {"ok": True, "how": "expand", "picked": node(c, 0)}
        except Exception:  # noqa: BLE001
            continue
    return {"ok": False, "reason": "没找到名字为 %r 的控件" % name}


def _find_at(x: int, y: int):
    """找出屏幕坐标 (x,y) 命中的 UIA 元素里**面积最小**的那个（= 最具体的那个）。

    很多按钮是没有名字的（比如面板右上角那个 ✕），按名字根本找不到；
    但它在树里有 rect，就能反查出来。取面积最小是为了避开「整个窗口的 Pane
    也包含这个点」这种情况。
    """
    best, best_area = None, None
    for c in _all_nodes(max_depth=14):
        try:
            r = c.BoundingRectangle
            if r.left <= x <= r.right and r.top <= y <= r.bottom:
                area = (r.right - r.left) * (r.bottom - r.top)
                if area <= 0:
                    continue
                if best_area is None or area < best_area:
                    best, best_area = c, area
        except Exception:  # noqa: BLE001
            continue
    return best


def invoke_named(name: str, exact: bool = True, dry: bool = False) -> dict:
    """按名字点一个控件。给「验证 Invoke 是否真的生效」用，也方便临时调别的按钮。

    特例：name 写成 ``@x,y`` 表示「在屏幕这个坐标真点一下」。
    有些控件（比如 CEF 自己画的下拉框，只有 invoke/legacy 模式，DoDefaultAction
    是空实现）UIA 怎么点都没反应，只能退回真实鼠标。真实鼠标在**提权进程**里
    才有效 —— 中完整性进程的 SendInput 会被 UIPI 静默丢掉，这条路径必须走代理。
    """
    if name.startswith("+expand:"):
        return expand_named(name[len("+expand:"):], exact=exact)

    if name.startswith("@"):
        try:
            x, y = [int(v) for v in name[1:].split(",")[:2]]
        except Exception:  # noqa: BLE001
            return {"ok": False, "reason": "坐标写法应为 @x,y，收到 %r" % name}
        if dry:
            hit = _find_at(x, y)
            return {"ok": True, "dry": True,
                    "picked": node(hit, 0) if hit else {"name": name,
                                                       "rect": [x, y, x, y]}}
        # 先按坐标反查元素再 Invoke —— 对 High IL 窗口唯一有效的路
        hit = _find_at(x, y)
        if hit is not None:
            how = invoke(hit)
            if how:
                return {"ok": True, "how": "invoke@" + how, "picked": node(hit, 0),
                        "at": [x, y]}
        # 再退回真实鼠标（本进程提权时才有效；edrAgent 可能会 hook 掉）
        return click_at(x, y)

    hits = []

    def rec(c, d):
        if d > 10:
            return
        try:
            nm = c.Name or ""
        except Exception:
            nm = ""
        ok = (nm.strip() == name) if exact else (name in nm)
        if ok:
            try:
                r = c.BoundingRectangle
                area = int(r.right - r.left) * int(r.bottom - r.top)
            except Exception:
                area = 0
            hits.append((area, c))
        try:
            kids = c.GetChildren()
        except Exception:
            return
        for k in kids:
            rec(k, d + 1)

    for ctrl, _ in roots():
        rec(ctrl, 0)
    if not hits:
        return {"ok": False, "reason": "没找到名字为 %r 的控件" % name}
    hits.sort(key=lambda x: -x[0])
    target = hits[0][1]
    info = node(target, 0)
    if dry:
        return {"ok": True, "dry": True, "picked": info, "count": len(hits)}
    how = invoke(target)
    if not how:
        return {"ok": False, "reason": "找到了但 UIA 模式都点不动", "picked": info}
    return {"ok": True, "how": how, "picked": info}


# ---------------------------------------------------------------- 动作
def invoke(ctrl) -> str | None:
    """自己 → 最多三层祖先，逐个试 UIA 模式。"""
    chain = []
    cur = ctrl
    for _ in range(4):
        chain.append(cur)
        try:
            cur = cur.GetParentControl()
        except Exception:
            break
        if cur is None:
            break

    for c in chain:
        for how, pid, method in (
            ("invoke", auto.PatternId.InvokePattern, "Invoke"),
            ("legacy", auto.PatternId.LegacyIAccessiblePattern, "DoDefaultAction"),
            ("selectitem", auto.PatternId.SelectionItemPattern, "Select"),
        ):
            try:
                p = c.GetPattern(pid)
                if p and getattr(p, method)():
                    return how
            except Exception:
                pass
        try:
            p = c.GetPattern(auto.PatternId.TogglePattern)
            if p:
                p.Toggle()
                return "toggle"
        except Exception:
            pass
    return None


def _all_nodes(max_depth: int = 10):
    out = []

    def rec(c, d):
        if d > max_depth:
            return
        out.append(c)
        try:
            kids = c.GetChildren()
        except Exception:
            return
        for k in kids:
            rec(k, d + 1)

    for ctrl, _ in roots():
        rec(ctrl, 0)
    return out


def _find_named(name: str, exact: bool = True, ctype: str | None = None):
    """按名字找第一个控件。"""
    for c in _all_nodes():
        try:
            nm = c.Name or ""
        except Exception:
            continue
        if (nm.strip() == name) if exact else (name in nm):
            if ctype and c.ControlTypeName != ctype:
                continue
            return c
    return None


def _has_text(sub: str) -> bool:
    for c in _all_nodes():
        try:
            if sub in (c.Name or ""):
                return True
        except Exception:
            continue
    return False


CONFIRM_TEXTS = ("结束当前直播", "结束直播", "确认要结束")


def confirm_stop(timeout: float = 5.0) -> str | None:
    """关播会弹二次确认「确认要结束当前直播吗？」+ 取消/确认。

    只在这个弹窗**确实出现**时才点「确认」，避免误点别的对话框。
    """
    end = time.time() + timeout
    while time.time() < end:
        if any(_has_text(t) for t in CONFIRM_TEXTS):
            for label in ("确认", "确定"):
                btn = _find_named(label, exact=True, ctype="ButtonControl") or _find_named(label, exact=True)
                if btn is not None:
                    how = invoke(btn)
                    if how:
                        return how
        time.sleep(0.5)
    return None


def act(kind: str, dry: bool = False) -> dict:
    """kind: start / stop

    注意：直播伴侣会同时存在多个 Chrome_WidgetWin_1 顶层窗口，同一颗按钮在
    每个窗口的树里都有一份，坐标差一个窗口偏移。其中只有一份是活的，
    另一份 Invoke 会失败（E_ELEMENTNOTAVAILABLE）。所以必须**逐个试到成功为止**，
    不能只试第一个。
    """
    ensure_visible()
    els = _elements_for(kind)
    if not els:
        if kind == "stop":
            return {
                "ok": False,
                "reason": "当前看起来没在开播（界面上没有「时长 + 关播」那个按钮），不用关",
                "tried": list(STOP_NAMES),
            }
        return {
            "ok": False,
            "reason": "界面上没找到「开始直播」按钮，先跑 mate_probe 看真实按钮名",
            "tried": list(START_NAMES),
        }
    if dry:
        return {"ok": True, "dry": True, "picked": node(els[0], 0), "count": len(els)}

    if kind == "stop":
        # 硬门槛：真关播按钮一定带直播时长前缀（00:02:28 关播）。
        # 没有这个信号就说明根本没在播，宁可失败也不乱点。
        first_name = ""
        try:
            first_name = els[0].Name or ""
        except Exception:
            pass
        if not _STOP_BTN_RE.search(first_name):
            return {
                "ok": False,
                "reason": "没找到带直播时长的「关播」按钮，判断为当前未开播",
                "picked": node(els[0], 0),
            }

    tried = []
    for c in els[:10]:
        info = node(c, 0)
        how = invoke(c)
        tried.append({"name": info["name"], "rect": info["rect"], "how": how})
        if how:
            res = {"ok": True, "how": how, "picked": info, "tried": tried}
            if kind == "stop":
                # 关播一定弹二次确认，顺手点掉
                time.sleep(1.0)
                res["confirm"] = confirm_stop() or "没弹确认框（可能已经直接停了）"
            return res
    return {
        "ok": False,
        "reason": "找到 %d 个候选但全部点不动" % len(tried),
        "picked": node(els[0], 0),
        "tried": tried,
    }


# ---------------------------------------------------------------- 状态
def state() -> dict:
    ensure_visible()
    rs = roots()
    if not rs:
        ws = list_windows()
        return {
            "ok": True,
            "running": bool(ws),
            "live": None,
            "uia": False,
            "reason": "窗口在，但 UIA 树取不到（跨完整性级别 / COM 没初始化）" if ws else "没在跑",
            "errors": list(LAST_ERRORS),
            "windows": ws,
        }
    nodes: list[dict] = []
    for ctrl, _ in rs:
        walk(ctrl, 0, 10, 4000, nodes, with_patterns=False)
    texts = [n["name"] for n in nodes if n["name"]]
    blob = " ".join(texts)

    # 判定只用「强信号」，别被文案骗：
    #   关播按钮 = 「00:02:28 关播」（带直播时长前缀）
    #   开播按钮 = 精确的「开始直播」
    # 「直播已结束」这种提示文案、以及确认框标题都不算。
    has_stop = any(_STOP_BTN_RE.search(t) for t in texts)
    has_start = any(t.strip() == "开始直播" for t in texts)
    hints = [h for h in LIVE_HINTS if h in blob]

    live = None
    if has_stop and not has_start:
        live = True
    elif has_start and not has_stop:
        live = False
    elif hints:
        live = True

    return {
        "ok": True,
        "running": True,
        "live": live,
        "title": rs[0][1].get("title", ""),
        "hasStartButton": has_start,
        "hasStopButton": has_stop,
        "hints": hints,
        "nodeCount": len(nodes),
        "windows": [w for _, w in rs],
    }


# ---------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(description="直播伴侣 UIA 控制层")
    ap.add_argument("cmd", choices=["windows", "probe", "state", "start", "stop", "click"])
    ap.add_argument("--depth", type=int, default=8)
    ap.add_argument("--nodes", type=int, default=1500)
    ap.add_argument("--out", default="")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--name", default="", help="click 用：控件名")
    ap.add_argument("--like", action="store_true", help="click 用：名字包含即可")
    a = ap.parse_args(argv)

    if a.cmd == "windows":
        r = {"ok": True, "windows": list_windows()}
    elif a.cmd == "probe":
        r = probe(a.depth, a.nodes)
    elif a.cmd == "state":
        r = state()
    elif a.cmd == "click":
        if not a.name:
            r = {"ok": False, "reason": "click 需要 --name"}
        else:
            r = invoke_named(a.name, exact=not a.like, dry=a.dry)
    else:
        r = act("start" if a.cmd == "start" else "stop", dry=a.dry)
        time.sleep(0.5)

    txt = json.dumps(r, ensure_ascii=False, indent=2)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(txt)
        print("已写入 %s（%d 字符）" % (a.out, len(txt)))
    else:
        print(txt)
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
