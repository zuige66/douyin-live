#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""volume.py —— 系统扬声器音量 / 静音开关（排查「直播没声音」的第一步）。

为什么要单独一个脚本：
    「音乐没声」最常见的根因不在 bridge、不在 musicd，而在 **Windows 系统音量被调低
    或静音**（2026-11-03 实测：vol=14% + mute=True，桥只会在 /healthz 的
    music.watch 里报一句「系统音量 14%（静音）」，它自己不改）。
    桥的看门狗只报警不动手，所以要有个人能一键复位。

用法：
    python tools/volume.py              # 只读：打印当前音量/静音/设备名
    python tools/volume.py 60           # 设成 60%（自动取消静音）
    python tools/volume.py 60 --mute    # 设成 60% 并静音（调试用）
    python tools/volume.py --unmute     # 只取消静音，音量不动

输出是单行 JSON，方便 node 侧 / agent 解析。
依赖 pycaw（.venv 里已装）；装不上时回 {"error": ...}，不抛异常。
"""
from __future__ import annotations

import json
import sys


def main() -> dict:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}

    try:
        from pycaw.pycaw import AudioUtilities
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}", "hint": "用 .venv\\Scripts\\python.exe 跑"}

    dev = AudioUtilities.GetSpeakers()
    ev = dev.EndpointVolume

    before = {
        "device": getattr(dev, "FriendlyName", "?"),
        "vol": round(ev.GetMasterVolumeLevelScalar(), 3),
        "mute": bool(ev.GetMute()),
    }
    if not args and not flags:
        return {"ok": True, "before": before, "changed": False}

    if args:
        want = max(0.0, min(1.0, float(args[0]) / 100.0))
        ev.SetMasterVolumeLevelScalar(want, None)

    # 设音量默认就取消静音 —— 静音状态下「设了音量还是没声」是最常见的误判。
    if "--mute" in flags:
        ev.SetMute(1, None)
    elif "--unmute" in flags or args:
        ev.SetMute(0, None)

    after = {
        "device": before["device"],
        "vol": round(ev.GetMasterVolumeLevelScalar(), 3),
        "mute": bool(ev.GetMute()),
    }
    return {"ok": True, "before": before, "after": after, "changed": True}


if __name__ == "__main__":
    print(json.dumps(main(), ensure_ascii=False))
