#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tools/tts.py —— 把一句话合成成音频，带缓存

为什么用 edge-tts 而不是本地 piper：
  主人 2026-10-26 拍板「edge-tts（慢 1.6 秒、更甜）」。
  piper 华言只要 0.39 秒且离线，但音色偏平；直播间要的是"像个少女在说话"。

缓存是这里最要紧的东西：
  实测冷启 2.04 秒、热 1.8~2.0 秒。弹幕一条条来，每条都等 2 秒就废了。
  但直播里短句重复率极高（"在呢""好听就多听几遍""谢谢你的心心"），
  按 (文本+音色+语速) 做 sha1 缓存，命中就是 0 延迟 —— 这才是能上直播的关键。

用法：
  python tools/tts.py --text "在呢，你来啦"            # 合成，打印 JSON
  python tools/tts.py --text "在呢" --voice zh-CN-XiaoxiaoNeural
  python tools/tts.py --list                            # 列中文女声
  python tools/tts.py --text "在呢" --no-cache           # 强制重合成
  python tools/tts.py --serve                           # 常驻，桥用这个

输出（stdout 一行 JSON，方便 node 直接 JSON.parse）：
  {"ok":true,"file":"...mp3","dur":2.34,"cached":true,"voice":"..."}
  {"ok":false,"error":"..."}

🔴 为什么有 --serve（2026-10-27）：
  一次性调用每次都要起 python（约 300ms，还要 import edge_tts）。
  观众的感受就是「字幕先出来，声音一秒后才响」。常驻之后这条命令 20ms。
  同一个改动也顺手治了 Windows 弹「出现错误 0x800700e8（没有足够的配额）」
  的对话框 —— 那是短时间连续 spawn 太多进程撞上的，对话框还会挡住直播伴侣。
"""
import argparse
import asyncio
import hashlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, "cache", "tts")

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"
# 🔴 2026-10-27：原来 +8%，主人反馈「语速太快了」。降到 -8%（比原来慢 16%）。
# 想再调：REPLY_TTS_RATE 环境变量，或者命令行 --rate "-15%"
DEFAULT_RATE = "-8%"
# edge-tts 固定输出 audio-24khz-48kbitrate-mono-mp3 ⇒ 48 kbit/s
BITRATE = 48000.0


def dur_of(path):
    """估算时长：按固定码率换算。

    没装 ffmpeg（这台机器确实没有），所以不解析 mp3 帧头 ——
    48kbps 定码率下 字节数*8/48000 的误差在 1% 以内，够用来定字幕停留时长。
    """
    try:
        return round(os.path.getsize(path) * 8 / BITRATE, 3)
    except OSError:
        return 0.0


def key_of(text, voice, rate, volume):
    h = hashlib.sha1()
    h.update(f"{voice}|{rate}|{volume}|{text}".encode("utf-8"))
    return h.hexdigest()[:20]


async def synth(text, voice, rate, volume, out_path):
    import edge_tts

    comm = edge_tts.Communicate(text, voice, rate=rate, volume=volume)
    # 先写临时文件再改名：合成中途断网不会留下半截 mp3 被下次当成缓存命中
    tmp = out_path + ".part"
    await comm.save(tmp)
    os.replace(tmp, out_path)


def synth_one(text, voice, rate, volume, no_cache=False, out=""):
    """合成一句，返回结果字典。一次性模式和常驻模式共用这一份逻辑。"""
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "没有文本"}

    os.makedirs(CACHE, exist_ok=True)
    k = key_of(text, voice, rate, volume)
    path = out or os.path.join(CACHE, k + ".mp3")

    if not no_cache and os.path.exists(path) and os.path.getsize(path) > 512:
        return {"ok": True, "file": path, "dur": dur_of(path),
                "cached": True, "voice": voice}

    t0 = time.time()
    try:
        asyncio.run(synth(text, voice, rate, volume, path))
    except Exception as e:  # 断网 / 被墙 / 音色名错 —— 都要让桥能优雅降级成"只有字幕"
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    if not os.path.exists(path) or os.path.getsize(path) < 512:
        return {"ok": False, "error": "合成出来的文件是空的"}

    return {"ok": True, "file": path, "dur": dur_of(path), "cached": False,
            "voice": voice, "ms": int((time.time() - t0) * 1000)}


def _say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve():
    """常驻：stdin 一行一条 JSON，stdout 一行一个结果。"""
    # Windows 上 stdout 默认 cp936，桥按 utf8 解 —— 不强制就全是乱码。
    # stdin 同理（2026-10-27）：桥写的是 UTF-8，按 cp936 解出来的中文是孤立代理字符
    # （'\udc80'），再 json.dumps 回去就 UnicodeEncodeError，进程当场退出 ——
    # 桥只好每句退回一次性 spawn，屏幕上就一直闪黑窗。
    for s in (sys.stdin, sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace", newline="\n")
        except Exception:
            pass

    try:
        import edge_tts  # noqa: F401  预热，别把 import 的 300ms 算在第一句头上
    except Exception as e:
        _say({"ok": False, "ready": False, "error": f"缺 edge-tts：{e}"})
        return

    sys.stderr.write("tts 常驻就绪\n")
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
        _say(synth_one(
            req.get("text", ""),
            req.get("voice") or DEFAULT_VOICE,
            req.get("rate") or DEFAULT_RATE,
            req.get("volume") or "+0%",
            bool(req.get("no_cache")),
            req.get("out") or "",
        ))


def main():
    # argparse 会把 "-8%" 当成一个选项（因为以减号开头），所以先把
    # `--rate -8%` 改写成 `--rate=-8%`。不然语速一调成负数就直接报错。
    argv = []
    it = iter(sys.argv[1:])
    for a in it:
        if a in ("--rate", "--volume") and (nxt := next(it, None)) is not None:
            argv.append(f"{a}={nxt}")
        else:
            argv.append(a)

    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default="")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--rate", default=DEFAULT_RATE)
    ap.add_argument("--volume", default="+0%")
    ap.add_argument("--out", default="")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--serve", action="store_true")
    a = ap.parse_args(argv)

    if a.serve:
        serve()
        return

    if a.list:
        import edge_tts

        async def ls():
            vs = await edge_tts.list_voices()
            for v in vs:
                if v["Locale"].startswith("zh-CN") and v["Gender"] == "Female":
                    tags = v.get("VoiceTag", {}).get("VoicePersonalities") or []
                    print(v["ShortName"], "|", ", ".join(tags))

        asyncio.run(ls())
        return

    print(json.dumps(
        synth_one(a.text, a.voice, a.rate, a.volume, a.no_cache, a.out),
        ensure_ascii=False))


if __name__ == "__main__":
    main()
