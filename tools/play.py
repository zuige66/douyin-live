#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tools/play.py —— 放音频（MCI，零依赖）

为什么用 MCI 而不是 pygame / playsound / ffplay：
  这台机器没装 ffmpeg，装 pygame 又要拖一整套 SDL。
  `winmm.dll` 的 MCI 是 Windows 自带的，能直接放 mp3/wav，
  `status <alias> length` 还能问出真实时长 —— 一行 ctypes 就够。

⚠️ 这个脚本**会一直阻塞到放完**才退出。
   桥那边"异步"是指 spawn 出去不 await，不是让这个进程提前退 ——
   进程一退 MCI 别名就关了，声音当场断掉。

用法：
  python tools/play.py --file a.mp3
  python tools/play.py --file a.mp3 --volume 300   # 0~1000
  python tools/play.py --serve                      # 常驻，桥用这个

输出（第一行 JSON，之后进程继续阻塞到放完）：
  {"ok":true,"dur":2.34,"file":"..."}

🔴 为什么有 --serve（2026-10-27）：
  以前每说一句都要 spawn 一个 python（约 300ms 才出声），观众听到的是
  「字幕出来了，声音一秒后才响」。而且短时间连开好几个，Windows 会弹
  「出现错误 0x800700e8（没有足够的配额来处理此命令）」的对话框，
  那个框还会挡在直播伴侣上面。常驻之后一条命令 20ms，也不再有 spawn 风暴。

  常驻模式是**串行**的：上一条没放完不会开始下一条，天然不会叠着说。
"""
import argparse
import ctypes
import json
import os
import sys
import time
import uuid

winmm = ctypes.windll.winmm


def mci(cmd):
    buf = ctypes.create_unicode_buffer(512)
    r = winmm.mciSendStringW(cmd, buf, 511, 0)
    return r, buf.value


def err_text(code):
    buf = ctypes.create_unicode_buffer(512)
    winmm.mciGetErrorStringW(code, buf, 511)
    return buf.value


def _open(path, volume):
    """打开并开始播放。返回 (alias, info)；失败时 alias 为 None。"""
    path = os.path.abspath(path)
    if not os.path.exists(path):
        return None, {"ok": False, "error": f"文件不存在：{path}"}

    alias = "dafeiyu" + uuid.uuid4().hex[:8]
    ext = os.path.splitext(path)[1].lower()
    kind = "mpegvideo" if ext in (".mp3", ".m4a", ".aac") else "waveaudio"

    r, _ = mci(f'open "{path}" type {kind} alias {alias}')
    if r != 0:
        # 有的文件按 mpegvideo 打不开、按 waveaudio 反而行，反过来再试一次
        alt = "waveaudio" if kind == "mpegvideo" else "mpegvideo"
        r, _ = mci(f'open "{path}" type {alt} alias {alias}')
        if r != 0:
            return None, {"ok": False, "error": f"MCI 打不开：{err_text(r)}"}

    r, ms = mci(f"status {alias} length")
    dur = (int(ms) / 1000.0) if r == 0 and ms.isdigit() else 0.0

    mci(f"setaudio {alias} volume to {max(0, min(1000, volume))}")

    r, _ = mci(f"play {alias}")
    if r != 0:
        mci(f"close {alias}")
        return None, {"ok": False, "error": f"放不出来：{err_text(r)}"}

    return alias, {"ok": True, "dur": dur, "file": path}


def _wait(alias, dur):
    """等它真的停下（给 2 秒余量：MCI 的 status 有时慢一拍，长音频还会晚一点置 stopped）"""
    deadline = time.time() + (dur or 5) + 2
    while time.time() < deadline:
        r, mode = mci(f"status {alias} mode")
        if r == 0 and mode == "stopped":
            break
        time.sleep(0.05)


def _say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def play_blocking(path, volume=1000, on_started=None, no_wait=False):
    """放完才返回。on_started(info) 在**刚开始放**的那一刻回调 ——
    桥靠它把「字幕上屏」和「声音开始」对齐。"""
    alias, info = _open(path, volume)
    if alias is None:
        return info
    try:
        if on_started:
            on_started(info)
        if not no_wait:
            _wait(alias, info.get("dur") or 5)
        return info
    finally:
        mci(f"close {alias}")


def serve():
    """常驻：stdin 一行一条 {"file":..., "volume":...}，开始播放时回一行。"""
    # stdin 也要 UTF-8：路径里可能有中文（cache/tts 目录、用户名），
    # 按 cp936 解会变成孤立代理字符，回包时 json.dumps 直接崩。
    for s in (sys.stdin, sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace", newline="\n")
        except Exception:
            pass

    sys.stderr.write("player 常驻就绪\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            _say({"ok": False, "error": f"JSON 坏了：{e}"})
            continue

        sent = {"done": False}

        def started(info, sent=sent):
            sent["done"] = True
            _say({**info, "at": int(time.time() * 1000)})

        out = play_blocking(
            req.get("file", ""),
            int(req.get("volume") or 1000),
            started,
            bool(req.get("no_wait")),
        )
        if not out.get("ok") and not sent["done"]:
            _say(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="")
    ap.add_argument("--volume", type=int, default=1000, help="0~1000")
    ap.add_argument("--no-wait", action="store_true", help="开了就退（调试用，声音会断）")
    ap.add_argument("--serve", action="store_true", help="常驻，从 stdin 读命令")
    a = ap.parse_args()

    if a.serve:
        serve()
        return

    if not a.file:
        _say({"ok": False, "error": "没有 --file"})
        return

    def started(info):
        _say(info)

    out = play_blocking(a.file, a.volume, started, a.no_wait)
    if not out.get("ok"):
        _say(out)


if __name__ == "__main__":
    main()
