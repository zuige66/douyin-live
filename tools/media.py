#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
media.py —— 直接控制本机的 QQ 音乐（以及任何支持 Windows 媒体控制的播放器）

原理
----
不走 QQ 音乐的私有协议，走 **Windows 自己的 SMTC**
（GlobalSystemMediaTransportControlsSessionManager，就是按 Win+G / 音量键旁边
弹出的那个「正在播放」浮窗背后的接口）。好处：

  · 零配置，QQ 音乐装好就支持，不用扫码登录、不用开 API、不用管理员权限
  · 换播放器也不用改代码（网易云、Spotify、PotPlayer 都实现了 SMTC）
  · 读得到歌名/艺人/专辑/播放状态，能发播放、暂停、上一首、下一首

音量单独走 WASAPI（pycaw），因为 SMTC 只管「播/停」，不管「多大声」。
有了它才能做 TTS 闪避 —— 她开口时把音乐压下去，说完再抬回来。

两种用法
--------
  一次性：  python tools/media.py --cmd get
            python tools/media.py --cmd playpause
  常驻：    python tools/media.py --serve
            从 stdin 读一行 JSON {"cmd":"get"}，往 stdout 回一行 JSON。
            桥用这个，省掉每次 300ms 的进程启动。

⚠️ stdout 只能有 JSON，日志一律走 stderr —— 桥是按行解析的。
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time

# Windows 上 Python 的 stdout 默认是 cp936（GBK）。桥那边是按 UTF-8 解 Buffer 的，
# 于是中文歌名到画面/面板上就成了一串「����」。实测《晴天》变 ���� 就是这么来的。
# 这里强制 UTF-8，两边才对齐。
#
# 🔴 stdin 也必须改（2026-10-27 修「点歌一有中文就崩」）：
#   桥写进来的是 UTF-8 的 JSON，Python 按 cp936 解码 → 中文变成孤立代理字符
#   （'\udc80' 这种），再 json.dumps 回给桥就 UnicodeEncodeError，进程当场死。
#   表现：点歌「最佳损友」→ 桥收到「音乐进程退出了」；tts 每句都崩 →
#   每回一句就退回一次性 spawn → 屏幕上一直闪黑窗。三处（media/tts/play）都要改。
for _s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    except Exception:
        pass

# ---------------------------------------------------------------- 常量
APP_HINT = ("qqmusic", "cloudmusic", "spotify", "kugou", "kuwo", "potplayer")

# PlaybackStatus 枚举（winrt 里是 IntEnum，这里不 import 也能用，省得版本差异）
ST_CLOSED, ST_OPENED, ST_CHANGING, ST_STOPPED, ST_PLAYING, ST_PAUSED = range(6)
ST_NAME = {
    0: "closed", 1: "opened", 2: "changing", 3: "stopped", 4: "playing", 5: "paused",
}

# 闪避：她说话时音乐压到原音量的多少
# 🔴 2026-10-27 主人要求「有声音的时候音乐调到 60%」，从 0.22 提上来。
# 0.22 几乎听不见了，观众会觉得歌断了；0.60 还听得见旋律，又不盖过人声。
# 注意 target 取的是 min(当前, DUCK_TO) —— 本来就没到 60% 的话不会反被调大。
DUCK_TO = 0.60

# 「原音量」低于这个数就当它是脏数据（2026-10-27 修）。
# 踩过的坑：某次在已经压着的时候存了 _saved，缓存文件里就落了个 0.22；
# 之后每次开播都「恢复」到 0.22，音乐整场只有 22%，查了半天才发现是缓存。
# 直播场景没人会把音乐主动调到 22% 以下，所以低于阈值一律当成 1.0。
VOL_SANE_FLOOR = 0.30


def sane_volume(v, default=1.0):
    try:
        v = float(v)
    except Exception:
        return default
    if v < VOL_SANE_FLOOR:
        return default
    return max(0.0, min(1.0, v))


# ------------------------------------------------------- 歌名比对
def norm(s):
    """歌名归一化：去掉括号内容、空格、标点，转小写。

    「孤勇者（Live版）」「孤勇者 (live)」「孤勇者」要能认成同一首 ——
    观众点歌不会写括号里的版本号。
    """
    s = str(s or "").lower()
    s = re.sub(r"[（(\[【][^）)\]】]*[）)\]】]", "", s)
    s = re.sub(r"[\s\-_·.、,，!！?？'\"“”‘’/\\]", "", s)
    return s


def same_song(a, b):
    """宽松比对：相等、或者一方包含另一方（「晴天」vs「晴天-周杰伦」）。"""
    a, b = norm(a), norm(b)
    if not a or not b:
        return False
    return a == b or a in b or b in a



def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- SMTC
class Smtc:
    """包一层，屏蔽 winrt 的异步细节；manager 只拿一次，后面复用。"""

    def __init__(self):
        self._mgr = None
        self._last = None  # (时间, 结果)，避免面板轮询把 SMTC 打爆

    async def _manager(self):
        if self._mgr is None:
            from winrt.windows.media.control import (
                GlobalSystemMediaTransportControlsSessionManager as Mgr,
            )
            self._mgr = await Mgr.request_async()
        return self._mgr

    async def _session(self):
        mgr = await self._manager()
        cur = mgr.get_current_session()
        # 🔴 只认音乐播放器，不认「系统当前会话」（2026-10-28 修）。
        #
        # 原来是 `if s is not None: return s` —— 直接返回系统当前会话，
        # 于是浏览器里放个 B 站视频/教程，桥就把视频标题当成"正在播放的音乐"：
        # 实测抓到过「下载dsh抖音刷视频插件 — DeepSeek Harness」，写进点歌台
        # 和画面，还跟着做 TTS 闪避。主人看到的是"怎么会有这种歌，串台了？"
        #
        # 现在按 APP_HINT 过一遍：当前会话是音乐播放器才用，否则在所有会话里
        # 找认识的；都不认识 = 没有播放器在跑（宁可说没有，也不报别人的视频）。
        cands = []
        if cur is not None:
            cands.append(cur)
        for x in mgr.get_sessions():
            if x is not None and x not in cands:
                cands.append(x)
        for s in cands:
            aid = (s.source_app_user_model_id or "").lower()
            if any(h in aid for h in APP_HINT):
                return s
        return None

    async def get(self, fresh=False):
        """当前在放什么。fresh=False 时 400ms 内复用上次结果。"""
        now = time.time()
        if not fresh and self._last and now - self._last[0] < 0.4:
            return self._last[1]

        out = {
            "ok": True, "found": False, "playing": False, "status": "none",
            "title": "", "artist": "", "album": "", "app": "", "pos": 0.0, "dur": 0.0,
        }
        try:
            s = await self._session()
            if s is None:
                out["ok"] = False
                out["why"] = "没有播放器在跑（QQ 音乐打开并播一首歌就行）"
            else:
                out["found"] = True
                out["app"] = s.source_app_user_model_id or ""
                info = s.get_playback_info()
                st = int(info.playback_status)
                out["status"] = ST_NAME.get(st, str(st))
                out["playing"] = st == ST_PLAYING
                try:
                    p = await s.try_get_media_properties_async()
                    out["title"] = (p.title or "").strip()
                    out["artist"] = (p.artist or "").strip()
                    out["album"] = (p.album_title or "").strip()
                except Exception as e:  # 有的播放器只实现控制、不实现元数据
                    log("读元数据失败:", e)
                try:
                    tl = s.get_timeline_properties()
                    out["pos"] = round(tl.position.total_seconds(), 1)
                    out["dur"] = round(tl.end_time.total_seconds(), 1)
                except Exception:
                    pass
        except Exception as e:
            out["ok"] = False
            out["why"] = f"{type(e).__name__}: {e}"

        self._last = (now, out)
        return out

    async def cmd(self, name):
        """播放控制。返回 {ok, did, status}。"""
        try:
            s = await self._session()
            if s is None:
                return {"ok": False, "why": "没有播放器在跑"}
            fn = {
                "playpause": s.try_toggle_play_pause_async,
                "play": s.try_play_async,
                "pause": s.try_pause_async,
                "next": s.try_skip_next_async,
                "prev": s.try_skip_previous_async,
                "stop": s.try_stop_async,
            }.get(name)
            if fn is None:
                return {"ok": False, "why": f"不认识的控制：{name}"}
            did = bool(await fn())
            self._last = None  # 状态变了，下次重新读
            await asyncio.sleep(0.18)
            now = await self.get(fresh=True)
            return {"ok": True, "did": did, "status": now.get("status"), "playing": now.get("playing")}
        except Exception as e:
            return {"ok": False, "why": f"{type(e).__name__}: {e}"}

    async def _skip(self, direction="next"):
        """切一首。每次重新取 session —— 切歌后 session 对象可能就失效了。"""
        s = await self._session()
        if s is None:
            return False
        fn = s.try_skip_next_async if direction == "next" else s.try_skip_previous_async
        ok = bool(await fn())
        self._last = None
        return ok

    async def _rewind_to(self, title, max_steps=12, settle=0.4):
        """往回切到指定歌，按到歌名对得上为止。

        ⚠️ 踩过的坑：QQ 音乐里如果当前歌已经播了几秒，`prev` 是「回到开头」
        **而不是「上一首」**。所以「翻了 N 首就按 N 次 prev」是错的 ——
        实测翻了 2 首按 2 次 prev，停在原地没动。只能看歌名来判。

        另一个坑：连续 next 之后立刻 prev，QQ 音乐有时会吞掉一两条命令，
        所以要连等两次失败才认输，不能一次失败就放弃。
        """
        # 刚翻完歌，先让它稳一下再往回按
        await asyncio.sleep(0.45)
        miss = 0
        for _ in range(max(4, int(max_steps))):
            t = await self.get(fresh=True)
            if same_song(t.get("title"), title):
                return True
            try:
                ok = await self._skip("prev")
            except Exception:
                ok = False
            if not ok:
                miss += 1
                if miss >= 5:
                    return False
                await asyncio.sleep(0.3)
                continue
            miss = 0
            await asyncio.sleep(settle)
        t = await self.get(fresh=True)
        return same_song(t.get("title"), title)

    async def play_song(self, name, max_skip=12, settle=0.3):
        """切到指定歌：从当前位置往后找，最多翻 max_skip 首。

        为什么是「往后翻」而不是「直接跳」：SMTC 只给 next / prev，
        没有「跳到第 N 首」。实测 next 之后约 230ms 歌名就更新了，
        所以一首 0.3 秒，翻 12 首 4 秒出头，观众能接受。

        翻不到就**原路退回**，别把人家听到一半的歌切跑了。

        🔴 settle 不能太短（2026-10-27）：SMTC 的歌名是**滞后**更新的。
        0.24 秒时偶尔还会读到**上一首**的歌名 —— 于是代码以为「没切过去」，
        再按一次 next，观众听到的就是「点的是第 3 首，放的是第 4 首」。
        现在每跳一次都记下跳之前的歌名，读回来的和它一样就多等 0.35 秒再读一次，
        确认是「真的没动」还是「只是没刷新」。
        """
        name = str(name or "").strip()
        if not name:
            return {"ok": False, "why": "没给歌名"}
        if await self._session() is None:
            return {"ok": False, "why": "没有播放器在跑"}

        cur = await self.get(fresh=True)
        start = cur.get("title") or ""
        if same_song(start, name):
            return {"ok": True, "found": True, "title": start, "skipped": 0}

        skipped = 0
        try:
            for _ in range(max(1, int(max_skip))):
                before = (await self.get(fresh=True)).get("title") or ""
                if not await self._skip("next"):
                    break
                skipped += 1
                await asyncio.sleep(settle)
                t = await self.get(fresh=True)
                title = t.get("title") or ""
                if before and same_song(title, before):
                    # 和跳之前一模一样：可能只是没刷新，再给一次机会
                    await asyncio.sleep(0.35)
                    t = await self.get(fresh=True)
                    title = t.get("title") or ""
                if same_song(title, name):
                    return {
                        "ok": True, "found": True, "title": title,
                        "artist": t.get("artist") or "", "skipped": skipped,
                    }
        except Exception as e:
            return {"ok": False, "why": f"{type(e).__name__}: {e}", "skipped": skipped}

        restored = await self._rewind_to(start, skipped * 3 + 2)
        back = await self.get(fresh=True)
        return {
            "ok": True, "found": False, "skipped": skipped, "restored": restored,
            "title": back.get("title") or "",
            "why": f"往后翻了 {skipped} 首没找到「{name}」",
        }

    async def list_queue(self, max_n=30, settle=0.55):
        """枚举当前播放队列：一路 next 直到绕回起点，再切回原位。

        ⚠️ **会真的切歌**，调用方必须先把音量压到听不见，否则观众听到的是
        一连串快进的残响。实测「暂停时切歌」也不行 —— QQ 音乐会自己恢复播放。

        ⚠️ settle 不能短。实测 0.34 秒时，连续切歌会读到**上一首的歌名**，
        结果整个队列每首重复两遍（太阳与地球 ×2、雨天 ×2…）。
        0.55 秒才稳。
        """
        if await self._session() is None:
            return {"ok": False, "why": "没有播放器在跑"}
        cur = await self.get(fresh=True)
        start = cur.get("title") or ""
        if not start:
            return {"ok": False, "why": "读不到当前歌名"}

        items = []
        looped = False
        last = start
        try:
            for i in range(max(1, int(max_n))):
                if not await self._skip("next"):
                    break
                await asyncio.sleep(settle)
                t = await self.get(fresh=True)
                title = t.get("title") or ""
                if not title:
                    break
                if same_song(title, last):
                    # 还没切过去，再给一次机会；还是同一首就是切不动了
                    await asyncio.sleep(0.45)
                    t = await self.get(fresh=True)
                    title = t.get("title") or ""
                    if same_song(title, last):
                        break
                # i>=1：至少转过一首才认「绕回起点」，否则单曲循环会立刻误判
                if i >= 1 and same_song(title, start):
                    looped = True
                    break
                items.append({"title": title, "artist": t.get("artist") or ""})
                last = title
        except Exception as e:
            return {"ok": False, "why": f"{type(e).__name__}: {e}", "items": items}

        if not looped:
            # 没绕回来（队列比 max_n 长，或者到头了），往回切回原曲。
            # 上限压到 20 步 —— 再多观众就听着音乐一直在倒带了。
            await self._rewind_to(start, min(24, len(items) * 2 + 4))
        back = await self.get(fresh=True)
        return {
            "ok": True,
            "items": items,
            "count": len(items),
            "looped": looped,
            "title": back.get("title") or "",
            "restored": same_song(back.get("title") or "", start),
        }


# ---------------------------------------------------------------- 音量
class Vol:
    """QQ 音乐进程的音量。WASAPI 是按「音频会话」调的，不影响系统总音量。

    闪避要还原原音量，而「原音量」得跨进程活下来 ——
    桥要是中途崩了、或者用一次性模式调了 duck，内存里的数就没了，
    音乐就会永远卡在 22%。所以存一个小文件。
    """

    def __init__(self):
        self._saved = None  # 闪避前的原音量
        self._file = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "cache", "media-duck.json",
        )
        self._load()

    def _load(self):
        try:
            with open(self._file, "r", encoding="utf-8") as f:
                v = json.load(f).get("saved")
            if isinstance(v, (int, float)) and 0.0 <= v <= 1.0:
                self._saved = sane_volume(v)
        except Exception:
            pass

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self._file), exist_ok=True)
            if self._saved is None:
                if os.path.exists(self._file):
                    os.remove(self._file)
            else:
                with open(self._file, "w", encoding="utf-8") as f:
                    json.dump({"saved": self._saved}, f)
        except Exception as e:
            log("存音量失败:", e)

    def _volumes(self, app_hint=None):
        """所有候选音量对象。

        ⚠️ QQ 音乐会同时开好几个音频会话（主播放、音效、歌词窗）。
        只改第一个的话，实测出现过「接口说设成 1.0、实际还停在 0.03」——
        压的时候压到了 A，恢复时读到的却是 B。所以统一对全部会话操作。
        """
        try:
            from pycaw.pycaw import AudioUtilities
        except Exception as e:
            return [], f"没装 pycaw：{e}"
        hint = (app_hint or "").lower()
        cands = []
        for s in AudioUtilities.GetAllSessions():
            proc = s.Process
            if not proc:
                continue
            try:
                name = proc.name().lower()
            except Exception:
                continue
            if any(h in name for h in APP_HINT):
                cands.append((name, s.SimpleAudioVolume))
        if not cands:
            return [], "没找到播放器的音频会话（QQ 音乐正在播才有）"
        if hint:
            picked = [(n, v) for n, v in cands if hint.split(".")[0] in n]
            if picked:
                return picked, None
        return cands, None

    def _volume(self, app_hint=None):
        vs, err = self._volumes(app_hint)
        return (vs[0][1] if vs else None), err

    def get(self, app_hint=None):
        vs, err = self._volumes(app_hint)
        if not vs:
            return {"ok": False, "why": err}
        v = vs[0][1]
        return {"ok": True, "vol": round(v.GetMasterVolume(), 3),
                "mute": bool(v.GetMute()), "sessions": len(vs)}

    def set(self, val, app_hint=None):
        vs, err = self._volumes(app_hint)
        if not vs:
            return {"ok": False, "why": err}
        val = max(0.0, min(1.0, float(val)))
        actual = None
        for _, v in vs:
            try:
                v.SetMasterVolume(val, None)
                actual = v.GetMasterVolume()
            except Exception:
                pass
        # 必须回读确认 —— SetMasterVolume 对失效的会话会「返回成功但不生效」
        ok = actual is not None and abs(actual - val) < 0.03
        return {"ok": ok, "vol": None if actual is None else round(actual, 3),
                "want": round(val, 3), "sessions": len(vs)}

    def restore(self, val, app_hint=None, tries=20):
        """把音量设回去，失败就重试。

        ⚠️ 踩过的坑：切歌那一瞬间 QQ 音乐的音频会话会重建，
        `GetAllSessions()` 有一两秒是找不到它的，这时 `set` 返回失败。
        只调一次的结果是音乐永远卡在 0.03 —— 实测静音了一整场。
        重试 20 次 × 0.15 秒 = 3 秒，足够跨过会话重建。
        """
        last = None
        for _ in range(tries):
            r = self.set(val, app_hint)
            if r.get("ok"):
                return r
            last = r
            time.sleep(0.15)
        return last or {"ok": False, "why": "恢复音量失败"}

    def duck(self, on, app_hint=None, to=None):
        """压低/恢复。on=True 时记住原音量，on=False 时还原。

        `to` 可以指定压到多少 —— 枚举播放队列时要压到几乎听不见（0.02），
        而 TTS 闪避只需要压到 0.22（还要能听到背景音乐）。
        """
        if on:
            v, err = self._volume(app_hint)
            if v is None:
                return {"ok": False, "why": err}
            cur = v.GetMasterVolume()
            # 已经压着就别把 0.22 当成「原音量」记进去（那样就永远抬不回来了）
            if self._saved is None:
                self._saved = sane_volume(cur)
                self._save()
            target = min(cur, DUCK_TO if to is None else max(0.0, float(to)))
            v.SetMasterVolume(target, None)
            return {"ok": True, "ducked": True, "vol": round(target, 3), "saved": round(self._saved, 3)}

        if self._saved is None:
            g = self.get(app_hint)
            return {"ok": True, "ducked": False, "vol": g.get("vol"), "note": "没压过，不用恢复"}
        back = self._saved
        # 走 restore：切歌时音频会话会重建，一次不成就重试。
        # `_saved` 只有真的恢复了才清空 —— 清早了万一失败就永远抬不回来。
        r = self.restore(back, app_hint)
        if r.get("ok"):
            self._saved = None
            self._save()
        return {"ok": bool(r.get("ok")), "ducked": False, "vol": r.get("vol"),
                "why": r.get("why")}


# ---------------------------------------------------------------- 分发
def sys_volume():
    """默认输出设备的系统音量 + 静音状态（2026-10-28）。

    为什么需要：绝大多数「没声音」不在代码里 —— 是系统默认输出切到了蓝牙耳机、
    耳机被静音、或者音量被拉到 2%。以前这些只能主人自己看右下角，
    桥这边一片绿，谁也说不清。现在每 30 秒读一次，进快照、上面板。
    """
    out = {"ok": False}
    try:
        from pycaw.pycaw import AudioUtilities

        dev = AudioUtilities.GetSpeakers()
        ev = getattr(dev, "EndpointVolume", None)
        if ev is None:
            # 老版 pycaw：GetSpeakers() 返回 IMMDevice，得自己 Activate
            from ctypes import cast, POINTER
            from comtypes import CLSCTX_ALL
            from pycaw.pycaw import IAudioEndpointVolume

            iface = dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
            ev = cast(iface, POINTER(IAudioEndpointVolume))
        out = {
            "ok": True,
            "dev": getattr(dev, "FriendlyName", "") or "",
            "vol": round(float(ev.GetMasterVolumeLevelScalar()), 3),
            "mute": bool(ev.GetMute()),
        }
    except Exception as e:
        out["why"] = f"{type(e).__name__}: {e}"
    return out


async def handle(req, smtc, vol):
    cmd = (req.get("cmd") or "get").lower()
    hint = req.get("app") or ""

    if cmd == "sysvol":
        return sys_volume()

    if cmd == "get":
        cur = await smtc.get(fresh=bool(req.get("fresh")))
        v = vol.get(hint)
        cur["volume"] = v.get("vol")
        return cur

    if cmd in ("playpause", "play", "pause", "next", "prev", "stop"):
        return await smtc.cmd(cmd)

    if cmd == "vol":
        return vol.set(req.get("v", 1.0), hint)

    if cmd == "duck":
        return vol.duck(bool(req.get("on")), hint, req.get("to"))

    # ---- 点歌：切到指定歌 ----
    if cmd == "song":
        name = req.get("name") or ""
        max_skip = int(req.get("max") or 12)
        # 翻歌时观众听到的是「快进残响」，压到几乎听不见，找到再抬回来。
        # 这里刻意用 get/set 而不是 duck：duck 的 _saved 是给 TTS 闪避用的，
        # 点歌时借走它会把她正在说话的闪避打断（音乐突然变响盖过人声）。
        # 默认不自己压音量 —— 桥那边会先调 duckMusic() 压下去再点歌，
        # 两边各压各的会打架（实测音量在 0.03 / 0.22 / 1.0 之间乱跳）。
        ducked = bool(req.get("duck", False))
        before = vol.get(hint).get("vol") if ducked else None
        if ducked and before is not None:
            vol.set(0.03, hint)
        try:
            r = await smtc.play_song(name, max_skip)
        finally:
            if ducked and before is not None:
                await asyncio.sleep(0.08)
                rv = vol.restore(before, hint)
                if isinstance(r, dict):
                    r["volume"] = rv.get("vol")
                    if not rv.get("ok"):
                        r["volumeFailed"] = True
        return r

    # ---- 枚举播放队列（会切歌，调用方负责压音量） ----
    if cmd == "queue":
        max_n = int(req.get("max") or 30)
        ducked = bool(req.get("duck", False))
        before = vol.get(hint).get("vol") if ducked else None
        if ducked and before is not None:
            vol.set(0.02, hint)
        try:
            r = await smtc.list_queue(max_n)
        finally:
            if ducked and before is not None:
                await asyncio.sleep(0.08)
                rv = vol.restore(before, hint)
                if isinstance(r, dict):
                    r["volume"] = rv.get("vol")
                    if not rv.get("ok"):
                        r["volumeFailed"] = True
        return r

    # ---- 开局体检：清掉上次没恢复的闪避 + 修「被压死在低位」的音量 ----
    if cmd == "reset":
        out = {"ok": True}
        if vol._saved is not None:
            r = vol.restore(vol._saved, hint)
            if r.get("ok"):
                out["restored"] = r.get("vol")
                vol._saved = None
                vol._save()
            else:
                out["why"] = r.get("why") or "还原失败"
        cur = vol.get(hint).get("vol")
        # 上次是被强杀的话，_saved 可能已经丢了，但音量还压在 3% ——
        # 这种情况没有任何记录能告诉我们「原来多大声」，只能拉回 1.0。
        if cur is not None and cur < VOL_SANE_FLOOR:
            r = vol.restore(1.0, hint)
            out["fixed"] = r.get("vol")
            out["wasLow"] = round(cur, 3)
        out["vol"] = vol.get(hint).get("vol")
        return out

    if cmd == "ping":
        return {"ok": True, "pong": True, "at": int(time.time() * 1000)}
    return {"ok": False, "why": f"不认识的命令：{cmd}"}


async def serve():
    smtc, vol = Smtc(), Vol()
    loop = asyncio.get_running_loop()
    log("media 常驻就绪")
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            log("stdin 关了，退出")
            return
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            out = {"ok": False, "why": f"JSON 坏了：{e}"}
        else:
            try:
                out = await handle(req, smtc, vol)
            except Exception as e:
                out = {"ok": False, "why": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cmd", default="get",
                    help="get|playpause|play|pause|next|prev|stop|vol|duck|song|queue")
    ap.add_argument("--v", type=float, default=1.0)
    ap.add_argument("--on", type=int, default=1)
    ap.add_argument("--app", default="")
    ap.add_argument("--name", default="", help="cmd=song 时点哪首歌")
    ap.add_argument("--max", type=int, default=0, help="cmd=song/queue 时最多翻几首")
    ap.add_argument("--duck", action="store_true", help="切歌时顺便压一下音量（桥不走这个，它自己压）")
    ap.add_argument("--serve", action="store_true")
    a = ap.parse_args()

    if a.serve:
        try:
            asyncio.run(serve())
        except KeyboardInterrupt:
            pass
        return

    smtc, vol = Smtc(), Vol()
    req = {"cmd": a.cmd, "v": a.v, "on": a.on, "app": a.app,
           "name": a.name, "duck": bool(a.duck)}
    if a.max:
        req["max"] = a.max
    out = asyncio.run(handle(req, smtc, vol))
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
