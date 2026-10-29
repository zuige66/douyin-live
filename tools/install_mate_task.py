#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""注册「登录即自启」的计划任务，让 mate_agent 一直在后台以最高权限跑着。

解决的问题：
    直播伴侣是 High IL 进程，控制它的代理必须提权。以前只能每次双击
    start-mate-agent.cmd 手动弹一次 UAC —— 人不在电脑前（远程）就没法用。
    这里把「提权」这件事一次性交给计划任务：登录 Windows 就自动起一个
    最高权限的代理，之后永远不用再点 UAC。

关键设置：
    /rl highest   ← 提权，且不弹 UAC
    登录触发      ← 必须跑在用户会话里，UIA 才看得到桌面
                    （不能做成 Windows 服务：服务在 session 0，看不到用户窗口）

⚠️ 刻意不用 XML 注册。`schtasks /create /xml` 对 <Settings> 子元素的顺序很挑，
   顺序错一点就整份被拒，而报错只有一句「参数错误」，极难排查（踩过一次）。
   走命令行开关没有这个问题。路径里没有空格，所以 /tr 连内嵌引号都不需要。

用法（需要管理员）：
    install-mate-agent-task.cmd            # 双击，自动提权
    python tools/install_mate_task.py      # 已在提权窗口里时直接跑
    python tools/install_mate_task.py --uninstall
    python tools/install_mate_task.py --status   # 只看状态，不用管理员

安装过程会写日志到 .run/mate-install.log，出问题直接看那个文件。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TASK_NAME = "zhibo-mate-agent"
RUN_DIR = os.path.join(ROOT, ".run")
TOKEN_FILE = os.path.join(RUN_DIR, "mate-token")
CONF_FILE = os.path.join(ROOT, "cache", "mate.json")
LOG_FILE = os.path.join(RUN_DIR, "mate-install.log")
PYTHONW = os.path.join(ROOT, ".venv", "Scripts", "pythonw.exe")
AGENT = os.path.join(HERE, "mate_agent.py")


# ---------------------------------------------------------------- 小工具
def log(msg: str):
    line = "%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(msg, flush=True)
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def run(args) -> tuple[int, str]:
    r = subprocess.run(args, capture_output=True)
    out = (r.stdout or b"") + (r.stderr or b"")
    try:
        txt = out.decode("mbcs", errors="replace")
    except Exception:
        txt = out.decode("utf-8", errors="replace")
    return r.returncode, txt.strip()


def conf() -> dict:
    c = {"bind": "127.0.0.1", "port": 18085}
    try:
        with open(CONF_FILE, "r", encoding="utf-8") as f:
            c.update(json.load(f))
    except Exception:
        pass
    return c


def health(port: int):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=3) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------- 任务查询（只读，不需要管理员）
def task_info():
    """返回 (found, dict)。用任务计划 COM，比 schtasks 好解析。

    ⚠️ `schtasks /create` 返回成功之后，Task Scheduler 服务有几十毫秒到几秒
    才把新任务挂上，这期间 GetTask 会报「找不到文件」。所以这里重试几次，
    不然会把「建成功了」误判成「没建成」（踩过一次，白让主人多点了一次 UAC）。
    """
    last_err = None
    for attempt in range(10):
        try:
            import comtypes
            import comtypes.client

            comtypes.CoInitialize()
            svc = comtypes.client.CreateObject("Schedule.Service")
            svc.Connect()
            root = svc.GetFolder("\\")
            try:
                t = root.GetTask(TASK_NAME)
            except Exception as e:
                last_err = e
                time.sleep(0.5)
                continue
            d = t.Definition
            p = d.Principal
            # ⚠️ 不要读 d.Actions.Item(i).Path：comtypes 把 Action 绑成 IAction，
            # 而 Path/Arguments 只存在于 IExecAction 上，直接取会 AttributeError('Path')。
            # 注册后的 XML 里什么都有，正则抠一下最省事。
            xml = t.Xml or ""

            def grab(tag):
                m = re.search(r"<%s>(.*?)</%s>" % (tag, tag), xml, re.S)
                return m.group(1) if m else None

            return True, {
                "state": t.State,
                "lastRun": t.LastRunTime,
                "nextRun": t.NextRunTime,
                "lastResult": t.LastTaskResult,
                "runLevel": p.RunLevel,
                "runLevelXml": grab("RunLevel"),
                "logonType": p.LogonType,
                "userId": p.UserId,
                "path": t.Path,
                "command": grab("Command"),
                "arguments": grab("Arguments"),
                "triggerTypes": [d.Triggers.Item(i + 1).Type for i in range(d.Triggers.Count)],
            }
        except Exception as e:
            last_err = e
            time.sleep(0.5)
    return False, {"error": repr(last_err) if last_err else "unknown"}


def show_status() -> int:
    found, info = task_info()
    if not found:
        if info.get("error"):
            log("查询计划任务出错（不一定是没建）：%s" % info["error"])
        else:
            log("计划任务「%s」不存在" % TASK_NAME)
        return 1
    log("计划任务「%s」存在：%s" % (TASK_NAME, json.dumps(info, ensure_ascii=False, default=str)))
    return 0


# ---------------------------------------------------------------- 安装
def stop_running(port: int) -> str:
    """把已经在跑的代理优雅关掉（比如手工起的那个），好让计划任务接管。"""
    h = health(port)
    if not h:
        return "没有在跑的实例"
    try:
        token = open(TOKEN_FILE, "r", encoding="utf-8").read().strip()
    except Exception:
        return "在跑（pid %s），但读不到 token，没法优雅停" % h.get("pid")
    req = urllib.request.Request(
        "http://127.0.0.1:%d/shutdown" % port,
        data=b"{}",
        method="POST",
        headers={"X-Mate-Token": token, "Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass
    for _ in range(20):
        time.sleep(0.3)
        if not health(port):
            return "已停掉旧实例（pid %s）" % h.get("pid")
    return "发了停止指令，但旧实例还占着端口 %d" % port


def install() -> int:
    log("=" * 60)
    log("安装计划任务 %s" % TASK_NAME)
    log("admin=%s  pythonw=%s" % (is_admin(), PYTHONW))
    if not is_admin():
        log("[ERROR] 需要管理员权限。请双击 install-mate-agent-task.cmd。")
        return 2
    for p, what in ((PYTHONW, "pythonw.exe"), (AGENT, "mate_agent.py")):
        if not os.path.exists(p):
            log("[ERROR] 找不到%s：%s" % (what, p))
            return 2

    # 路径里没有空格，所以整条命令可以不带引号塞进 /tr
    tr = "%s %s" % (PYTHONW, AGENT)
    rc, out = run(
        ["schtasks", "/create", "/tn", TASK_NAME, "/tr", tr, "/sc", "onlogon", "/rl", "highest", "/f"]
    )
    log("schtasks /create -> rc=%d" % rc)
    if out:
        log("  " + out.replace("\n", "\n  "))

    found, info = task_info()
    if not found:
        log("[ERROR] 任务没建成功。上面 schtasks 的输出就是原因。")
        return 1
    log("✓ 任务已注册：%s" % json.dumps(info, ensure_ascii=False, default=str))
    if info.get("runLevel") != 1:
        log("[WARN] RunLevel=%s，期望 1（最高权限）。远程会点不动。" % info.get("runLevel"))

    # 建好之后才停旧实例，避免中途失败把人晾着
    port = int(conf().get("port") or 18085)
    log("· " + stop_running(port))

    rc, out = run(["schtasks", "/run", "/tn", TASK_NAME])
    log("schtasks /run -> rc=%d %s" % (rc, out))

    for _ in range(30):
        time.sleep(0.5)
        h = health(port)
        if h:
            log("✓ 代理已起来：pid=%s admin=%s port=%s" % (h.get("pid"), h.get("admin"), port))
            if not h.get("admin"):
                log("[WARN] 不是提权状态！检查任务的「使用最高权限运行」。")
            log("以后登录 Windows 就自动起，不用再点任何东西。")
            log("代理日志：%s" % os.path.join(RUN_DIR, "mate-agent.log"))
            return 0
    log("[WARN] 任务已注册，但 15 秒内没等到代理响应。看 %s" % os.path.join(RUN_DIR, "mate-agent.log"))
    return 1


def uninstall() -> int:
    log("=" * 60)
    log("卸载计划任务 %s" % TASK_NAME)
    if not is_admin():
        log("[ERROR] 需要管理员权限。请双击 uninstall-mate-agent-task.cmd。")
        return 2
    port = int(conf().get("port") or 18085)
    log("· " + stop_running(port))
    rc, out = run(["schtasks", "/delete", "/tn", TASK_NAME, "/f"])
    log("schtasks /delete -> rc=%d %s" % (rc, out))
    found, _ = task_info()
    if found:
        log("[ERROR] 删除后任务仍然存在")
        return 1
    log("✓ 计划任务已删除，代理已停")
    return 0


if __name__ == "__main__":
    if "--uninstall" in sys.argv:
        sys.exit(uninstall())
    if "--status" in sys.argv:
        sys.exit(show_status())
    sys.exit(install())
