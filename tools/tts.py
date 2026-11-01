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
  python tools/tts.py --text "在呢" --pitch "+20Hz"     # 音高上抬（少女感）
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

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
# 🔴 2026-10-27：原来 +8%，主人反馈「语速太快了」。降到 -8%（比原来慢 16%）。
# 想再调：REPLY_TTS_RATE 环境变量，或者命令行 --rate "-15%"
DEFAULT_RATE = "-8%"
# 音高（2026-10-30 加）。edge-tts 原生支持，只是以前没接。
# 正数上抬更有「少女感」，负数更沉更成熟。同一个 voice 靠它也能变出几种味道，
# 这是「换声线」成本最低的一条路（不用换供应商）。
DEFAULT_PITCH = "+0Hz"
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


def key_of(text, voice, rate, volume, pitch=DEFAULT_PITCH):
    """缓存 key。

    🔴 pitch 只在**非默认值**时才拼进 key —— 这样加音高功能不会把
       之前攒下的整库缓存全部作废（直播中换一次全部冷启动，前几十句
       每句慢 2 秒，观众能直接听出来）。默认 +0Hz 时 key 与老版本一致。
    """
    h = hashlib.sha1()
    seed = f"{voice}|{rate}|{volume}"
    if pitch and pitch not in ("+0Hz", "0Hz", "0"):
        seed += f"|{pitch}"
    h.update(f"{seed}|{text}".encode("utf-8"))
    return h.hexdigest()[:20]


async def synth(text, voice, rate, volume, out_path, pitch=DEFAULT_PITCH):
    import edge_tts

    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    # 先写临时文件再改名：合成中途断网不会留下半截 mp3 被下次当成缓存命中
    tmp = out_path + ".part"
    await comm.save(tmp)
    os.replace(tmp, out_path)


async def synth_marks(text, voice, rate, volume, out_path, pitch=DEFAULT_PITCH,
                      boundary="SentenceBoundary"):
    """合成，并顺手把逐句时间戳捞出来。

    为什么不能用 save()：它把事件全吞了。只有 stream() 能拿到 boundary 事件，
    offset/duration 的单位是 100 纳秒，除以 10000 得到毫秒。

    🔴 这个时间戳是视频弹幕对齐的命根子。以前按「字数比例」硬分时长，
       实测第一条弹幕比配音晚 1.5 秒（TTS 读 290 字用 75 秒，句间停顿才
       0.35 秒，字数里根本不含停顿），观众的感受就是「声音先出来，弹幕后到」。
       有了真时间戳，弹幕跟念到哪儿严格同步，长句短句都不会漂。
    """
    import edge_tts

    kw = dict(rate=rate, pitch=pitch, volume=volume)
    try:
        comm = edge_tts.Communicate(text, voice, boundary=boundary, **kw)
    except TypeError:
        # 老版本 edge-tts 没有 boundary 参数，也就拿不到时间戳
        comm = edge_tts.Communicate(text, voice, **kw)

    tmp = out_path + ".part"
    marks = []
    with open(tmp, "wb") as f:
        async for ch in comm.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            else:
                marks.append({
                    "t": round(ch["offset"] / 10000.0, 1),
                    "d": round(ch["duration"] / 10000.0, 1),
                    "text": ch["text"],
                })
    os.replace(tmp, out_path)
    return marks


def synth_one(text, voice, rate, volume, no_cache=False, out="", pitch=DEFAULT_PITCH,
              timing_out="", boundary="SentenceBoundary"):
    """合成一句，返回结果字典。一次性模式和常驻模式共用这一份逻辑。

    timing_out 非空时额外写一份逐句时间戳 JSON（视频弹幕对齐用），
    并把 marks 塞进返回值。直播桥不传这个参数，行为完全不变。
    """
    text = (text or "").strip()
    if not text:
        return {"ok": False, "error": "没有文本"}

    os.makedirs(CACHE, exist_ok=True)
    k = key_of(text, voice, rate, volume, pitch)
    path = out or os.path.join(CACHE, k + ".mp3")
    need_marks = bool(timing_out)

    hit = (os.path.exists(path) and os.path.getsize(path) > 512
           and (not need_marks or os.path.exists(timing_out)))
    if not no_cache and hit:
        r = {"ok": True, "file": path, "dur": dur_of(path),
             "cached": True, "voice": voice, "pitch": pitch}
        if need_marks:
            try:
                with open(timing_out, encoding="utf-8") as f:
                    r["marks"] = json.load(f).get("marks") or []
            except Exception:
                r["marks"] = []
        return r

    t0 = time.time()
    try:
        if need_marks:
            marks = asyncio.run(synth_marks(text, voice, rate, volume, path, pitch, boundary))
            with open(timing_out, "w", encoding="utf-8") as f:
                json.dump({"text": text, "voice": voice, "rate": rate, "marks": marks},
                          f, ensure_ascii=False)
        else:
            asyncio.run(synth(text, voice, rate, volume, path, pitch))
    except Exception as e:  # 断网 / 被墙 / 音色名错 —— 都要让桥能优雅降级成"只有字幕"
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    if not os.path.exists(path) or os.path.getsize(path) < 512:
        return {"ok": False, "error": "合成出来的文件是空的"}

    r = {"ok": True, "file": path, "dur": dur_of(path), "cached": False,
         "voice": voice, "pitch": pitch, "ms": int((time.time() - t0) * 1000)}
    if need_marks:
        r["marks"] = marks
    return r


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
            req.get("pitch") or DEFAULT_PITCH,
        ))


def main():
    # argparse 会把 "-8%" 当成一个选项（因为以减号开头），所以先把
    # `--rate -8%` 改写成 `--rate=-8%`。不然语速一调成负数就直接报错。
    # 2026-10-30：--pitch 同理（"-20Hz" 也以减号开头），一起处理。
    argv = []
    it = iter(sys.argv[1:])
    for a in it:
        if a in ("--rate", "--volume", "--pitch") and (nxt := next(it, None)) is not None:
            argv.append(f"{a}={nxt}")
        else:
            argv.append(a)

    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default="")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--rate", default=DEFAULT_RATE)
    ap.add_argument("--volume", default="+0%")
    ap.add_argument("--pitch", default=DEFAULT_PITCH)
    ap.add_argument("--out", default="")
    ap.add_argument("--no-cache", action="store_true")
    # 逐句时间戳（视频弹幕对齐用）。不传就完全走老路径，直播桥不受影响。
    ap.add_argument("--timing-out", default="")
    ap.add_argument("--boundary", default="SentenceBoundary",
                    choices=["SentenceBoundary", "WordBoundary"])
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
        synth_one(a.text, a.voice, a.rate, a.volume, a.no_cache, a.out, a.pitch,
                  a.timing_out, a.boundary),
        ensure_ascii=False))


if __name__ == "__main__":
    main()
