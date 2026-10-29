#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""mate_agent —— 直播伴侣控制代理（必须以管理员身份运行）。

为什么需要单独一个提权进程：
    直播伴侣主程序 manifest 是 requireAdministrator + uiAccess，跑在 High IL。
    WorkBuddy 派生出来的 MCP 进程是 Medium IL，跨不过 UIPI —— 既点不动，
    也读不到对方的 UIA 树（多半）。所以：
        MCP(Medium, stdio)  --HTTP 127.0.0.1:18085-->  mate_agent(High)  --UIA-->  直播伴侣

启动：双击仓库根目录的 start-mate-agent.cmd（会弹 UAC）。

接口（全部只绑 127.0.0.1，且要带 X-Mate-Token）：
    GET  /health              代理自身状态（是否提权、UIA 是否可用）
    GET  /state               直播伴侣是否在跑 / 是否在播
    POST /live/start          开播
    POST /live/stop           关播
    GET  /probe?depth=8       dump UIA 树（找按钮名用）
    POST /launch              启动直播伴侣（提权 agent 代劳，不再弹 UAC）
    POST /shutdown            关掉代理

配置：cache/mate.json（可选）
    {"port": 18085, "launcher": "D:\\...\\直播伴侣 Launcher.exe"}
"""
from __future__ import annotations

import ctypes
import importlib
import json
import os
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

DEFAULT_LAUNCHER = r"D:\Apps\zhibo\webcast_mate\直播伴侣 Launcher.exe"

sys.path.insert(0, HERE)
import mate_uia  # noqa: E402


def log(msg: str):
    sys.stderr.write("[mate-agent] %s\n" % msg)
    sys.stderr.flush()


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def load_conf() -> dict:
    conf = {"port": 18085, "launcher": DEFAULT_LAUNCHER}
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
    # 等主窗口出来（最多 40 秒）
    for _ in range(80):
        time.sleep(0.5)
        if mate_uia.list_windows():
            return {"ok": True, "started": True}
    return {"ok": False, "reason": "已发起启动，但 40 秒内没等到窗口"}


def do_reload() -> dict:
    """热重载 mate_uia，改完脚本不用重开 UAC 窗口。"""
    importlib.reload(mate_uia)
    return {"ok": True, "reloaded": "mate_uia"}


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
    if not is_admin():
        log("⚠️  当前不是管理员。直播伴侣跑在 High IL，非提权点不动。")
        log("   请改用 start-mate-agent.cmd 启动（会弹 UAC）。")

    # 🔴 COM 必须在**处理请求的那个线程**上初始化。
    # 所以这里故意用单线程的 HTTPServer：ThreadingHTTPServer 每个请求开新线程，
    # UIA 的 IUIAutomation 是 STA 对象，跨线程用会直接失败（表现为
    # 「list_windows 有窗口，但 ControlFromHandle 全 None」——排查了两轮）。
    import comtypes

    comtypes.CoInitialize()
    log("token 文件: %s" % TOKEN_FILE)
    srv = HTTPServer(("127.0.0.1", port), Handler)
    log("已监听 http://127.0.0.1:%d  （admin=%s）" % (port, is_admin()))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        comtypes.CoUninitialize()
    log("已退出")


if __name__ == "__main__":
    main()
