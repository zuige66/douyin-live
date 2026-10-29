#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""mate_agent —— 直播伴侣控制代理（必须以管理员身份运行）。

为什么需要单独一个提权进程：
    直播伴侣主程序 manifest 是 requireAdministrator + uiAccess，跑在 High IL。
    WorkBuddy 派生出来的 MCP 进程是 Medium IL，跨不过 UIPI —— 既点不动，
    也读不到对方的 UIA 树（多半）。所以：
        MCP(Medium, stdio)  --HTTP 127.0.0.1:18085-->  mate_agent(High)  --UIA-->  直播伴侣

启动（三种，任选）：
    1. 计划任务（推荐，远程用这个）：跑一次 install-mate-agent-task.cmd 注册开机自启，
       以后登录 Windows 就自动在后台起一个提权代理，**不再弹 UAC、不用手动点**。
    2. 双击仓库根目录的 start-mate-agent.cmd（弹一次 UAC，关窗口即停）。
    3. 由别的程序直接调用（必须是提权进程）。

接口（全部带 X-Mate-Token，token 在 .run/mate-token）：
    GET  /health              代理自身状态（是否提权、UIA 是否可用）
    GET  /state               直播伴侣是否在跑 / 是否在播
    POST /live/start          开播
    POST /live/stop           关播（自动点二次确认）
    GET  /probe?depth=8       dump UIA 树（找按钮名用）
    POST /click               按控件名点一下（调试/兜底）
    POST /launch              启动直播伴侣（提权 agent 代劳，不再弹 UAC）
    POST /reload              热重载 mate_uia（改脚本不用重启）
    POST /shutdown            关掉代理

配置：cache/mate.json（可选）
    {"bind": "127.0.0.1", "port": 18085, "launcher": "D:\\...\\直播伴侣 Launcher.exe"}
    bind 默认 127.0.0.1。只有 MCP 不在本机时才考虑改 0.0.0.0（见文档「远程」一节）。
"""
from __future__ import annotations

import ctypes
import importlib
import json
import os
import socket
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RUN_DIR = os.path.join(ROOT, ".run")
CACHE_DIR = os.path.join(ROOT, "cache")
TOKEN_FILE = os.path.join(RUN_DIR, "mate-token")
CONF_FILE = os.path.join(CACHE_DIR, "mate.json")
LOG_FILE = os.path.join(RUN_DIR, "mate-agent.log")

DEFAULT_LAUNCHER = r"D:\Apps\zhibo\webcast_mate\直播伴侣 Launcher.exe"

sys.path.insert(0, HERE)
import mate_uia  # noqa: E402


def log(msg: str):
    """写日志。计划任务用 pythonw 起，没有 stderr，所以必须落文件。"""
    line = "%s [mate-agent] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        # 超过 1MB 就轮转一份，别让它无限长
        try:
            if os.path.getsize(LOG_FILE) > 1024 * 1024:
                os.replace(LOG_FILE, LOG_FILE + ".1")
        except OSError:
            pass
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    try:
        if sys.stderr is not None:
            sys.stderr.write(line)
            sys.stderr.flush()
    except Exception:
        pass


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def load_conf() -> dict:
    conf = {"bind": "127.0.0.1", "port": 18085, "launcher": DEFAULT_LAUNCHER}
    try:
        with open(CONF_FILE, "r", encoding="utf-8") as f:
            conf.update(json.load(f))
    except Exception:
        pass
    return conf


def get_token() -> str:
    os.makedirs(RUN_DIR, exist_ok=True)
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            t = f.read().strip()
            if t:
                return t
    except Exception:
        pass
    import secrets

    t = secrets.token_hex(16)
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        f.write(t)
    return t


TOKEN = get_token()
CONF = load_conf()
_lock = threading.Lock()


def do_launch() -> dict:
    launcher = CONF.get("launcher") or DEFAULT_LAUNCHER
    if not os.path.exists(launcher):
        return {"ok": False, "reason": "找不到 Launcher: %s" % launcher}
    if mate_uia.list_windows():
        return {"ok": True, "already": True}
    try:
        import subprocess

        subprocess.Popen([launcher], cwd=os.path.dirname(launcher), close_fds=True)
    except Exception as e:
        return {"ok": False, "reason": "启动失败: %r" % (e,)}
    # 等主窗口出来（冷启动要拉起 12 个进程，慢的时候 60 秒开外）
    for _ in range(180):
        time.sleep(0.5)
        if mate_uia.list_windows():
            return {"ok": True, "started": True}
    return {"ok": False, "reason": "已发起启动，但 90 秒内没等到窗口（可能卡在登录/协议弹窗）"}


def do_reload() -> dict:
    """热重载 mate_uia，改完脚本不用重开 UAC 窗口。"""
    importlib.reload(mate_uia)
    return {"ok": True, "reloaded": "mate_uia"}


class MateServer(HTTPServer):
    """独占端口。

    🔴 Windows 上 http.server.HTTPServer 的 allow_reuse_address = 1，
    语义是「允许两个进程同时绑同一个端口」（Linux 那套是「TIME_WAIT 也能复用」，
    Windows 直接变成随便抢）。后果：手工起的代理和计划任务起的代理会**同时**
    LISTENING 在 18085，请求随机落到其中一个 —— 表现是「有时候提权、有时候不提权」，
    极难查。实测踩过一次。
    """

    allow_reuse_address = False

    def server_bind(self):
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if excl is not None:
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, excl, 1)
            except OSError:
                pass
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    server_version = "mate-agent/1.0"

    def log_message(self, fmt, *args):  # 静音默认访问日志
        pass

    def _send(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self) -> bool:
        if self.headers.get("X-Mate-Token") == TOKEN:
            return True
        self._send(403, {"ok": False, "reason": "token 不对，读 .run/mate-token"})
        return False

    def _guard(self, fn):
        try:
            with _lock:
                r = fn()
            self._send(200, r if isinstance(r, dict) else {"ok": True, "result": r})
        except Exception:
            log(traceback.format_exc())
            self._send(500, {"ok": False, "reason": "内部错误", "trace": traceback.format_exc()[-800:]})

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            self._send(
                200,
                {
                    "ok": True,
                    "admin": is_admin(),
                    "uia": True,
                    "pid": os.getpid(),
                    "port": CONF.get("port"),
                    "windows": mate_uia.list_windows(),
                },
            )
            return
        if not self._auth():
            return
        if u.path == "/state":
            self._guard(mate_uia.state)
        elif u.path == "/probe":
            depth = int((q.get("depth") or ["8"])[0])
            nodes = int((q.get("nodes") or ["1200"])[0])
            self._guard(lambda: mate_uia.probe(depth, nodes))
        else:
            self._send(404, {"ok": False, "reason": "没有这个接口: %s" % u.path})

    def do_POST(self):
        u = urlparse(self.path)
        if not self._auth():
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = {}
        if n:
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                body = {}
        if u.path == "/live/start":
            self._guard(lambda: mate_uia.act("start"))
        elif u.path == "/live/stop":
            self._guard(lambda: mate_uia.act("stop"))
        elif u.path == "/click":
            name = str(body.get("name") or "")
            exact = body.get("exact", True)
            dry = bool(body.get("dry", False))
            self._guard(lambda: mate_uia.invoke_named(name, exact=exact, dry=dry))
        elif u.path == "/launch":
            self._guard(do_launch)
        elif u.path == "/reload":
            self._guard(do_reload)
        elif u.path == "/shutdown":
            self._send(200, {"ok": True, "bye": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self._send(404, {"ok": False, "reason": "没有这个接口: %s" % u.path})


def main():
    port = int(CONF.get("port") or 18085)
    bind = str(CONF.get("bind") or "127.0.0.1")
    if not is_admin():
        log("⚠️  当前不是管理员。直播伴侣跑在 High IL，非提权点不动。")
        log("   计划任务里配的是「最高权限」，用 install-mate-agent-task.cmd 注册。")

    # 🔴 COM 必须在**处理请求的那个线程**上初始化。
    # 所以这里故意用单线程的 HTTPServer：ThreadingHTTPServer 每个请求开新线程，
    # UIA 的 IUIAutomation 是 STA 对象，跨线程用会直接失败（表现为
    # 「list_windows 有窗口，但 ControlFromHandle 全 None」——排查了两轮）。
    import comtypes

    comtypes.CoInitialize()
    try:
        srv = MateServer((bind, port), Handler)
    except OSError as e:
        # 端口被占 = 已经有一个实例在跑（手工起的 / 计划任务起的）。
        # 计划任务每 5 分钟会重试一次，这里安静退出，别刷日志。
        log("端口 %s:%d 已被占用（%s），判断已有实例在跑，本进程退出" % (bind, port, e))
        comtypes.CoUninitialize()
        return 0

    log("已监听 http://%s:%d  （admin=%s，pid=%d）" % (bind, port, is_admin(), os.getpid()))
    log("token 文件: %s" % TOKEN_FILE)
    if bind not in ("127.0.0.1", "localhost", "::1"):
        log("⚠️  绑在 %s，同网段的人都能连（要 token）。非必要别这么配。" % bind)
    try:
        # 自愈：serve_forever 里出异常就歇 3 秒继续，别让代理整个死掉。
        # （计划任务只在登录时拉一次，远程场景没人能手动重启）
        while True:
            try:
                srv.serve_forever()
                break  # /shutdown 之后正常返回
            except KeyboardInterrupt:
                break
            except Exception:
                log("serve_forever 异常，3 秒后继续：\n" + traceback.format_exc()[-800:])
                time.sleep(3)
    finally:
        comtypes.CoUninitialize()
    log("已退出")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
