#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""礼物档位媒体 · 解码引擎

直播画面右侧那台「电脑」里放的东西，全在这个文件里变成一张 PIL 图。

分工：
    bridge.mjs   决定「现在该播哪一份」（队列 / 打断 / 冷却都在那边）
    media.py     只管「把这一份解出来」，一帧一帧交给 render.py 贴到屏幕上

支持：
    图片  png / jpg / jpeg / webp / bmp        → 静态，按 contain 缩放
    GIF   gif                                  → 逐帧 + 每帧自己的时长
    视频  mp4 / webm / mov / mkv / m4v         → ffmpeg 管道出 RGB 帧
    音频  mp3 / wav / m4a / aac / ogg / flac   → 屏幕画波形，声音走 MCI

为什么音频用 MCI 而不是 pygame / winsound：
    · winsound 只认 wav；
    · pygame 没装，为一个 15 秒的音效装 30MB 不值；
    · MCI 是 Windows 自带的（winmm.dll），mp3/wav/m4a 都能放，
      还能 setaudio volume —— 正好要按档位调音量。

为什么视频用 ffmpeg 管道而不是 PyAV：
    imageio-ffmpeg 只带一个 ffmpeg.exe，比 PyAV（几十 MB 的 .pyd）轻，
    而且 `-vf scale` 在 C 层就把帧缩到屏幕大小，Python 这边只读
    434×244×3 ≈ 318KB/帧，15fps 下完全跟得上。
"""
import ctypes
import hashlib
import os
import subprocess
import sys
import tempfile
import time

from PIL import Image

try:
    import imageio_ffmpeg

    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:  # noqa: BLE001
    FFMPEG = ""

VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma"}
ANIM_EXT = {".gif", ".webp"}  # webp 也按动图试一次，静态的会退化成单帧

# ── MCI（Windows 自带，放 mp3 / wav / m4a）─────────────────────────────
try:
    _winmm = ctypes.WinDLL("winmm")
except Exception:  # noqa: BLE001
    _winmm = None

_ALIAS = "dymedia"
_audio_open = False


def _mci(cmd, quiet=False):
    if _winmm is None:
        return ""
    buf = ctypes.create_unicode_buffer(1024)
    err = _winmm.mciSendStringW(cmd, buf, 1024, None)
    if err:
        if quiet:
            return ""
        eb = ctypes.create_unicode_buffer(512)
        _winmm.mciGetErrorStringW(err, eb, 512)
        raise OSError(f"MCI {eb.value}：{cmd}")
    return buf.value


def _mci_close():
    global _audio_open
    if _audio_open:
        _mci(f"close {_ALIAS}", quiet=True)
        _audio_open = False


def _mci_play(path, volume=1.0):
    """放一个音频文件。失败返回 False（调用方当静音处理，不影响画面）。"""
    global _audio_open
    _mci_close()
    if _winmm is None or not path or not os.path.exists(path):
        return False
    ext = os.path.splitext(path)[1].lower()
    types = ["waveaudio"] if ext == ".wav" else ["mpegvideo", "waveaudio", ""]
    for t in types:
        cmd = f'open "{path}"' + (f" type {t}" if t else "") + f" alias {_ALIAS}"
        try:
            _mci(cmd)
        except OSError:
            continue
        _audio_open = True
        break
    if not _audio_open:
        return False
    try:
        _mci(f"setaudio {_ALIAS} volume to {max(0, min(1000, int(volume * 1000)))}", quiet=True)
        _mci(f"play {_ALIAS}")
    except OSError:
        return False
    return True


def _mci_mode():
    try:
        return _mci(f"status {_ALIAS} mode", quiet=True)
    except OSError:
        return ""


def _mci_volume(v):
    """中途改音量（她说话时桥会把 0 档视频压到 20%）。

    MCI 的 `setaudio volume` 是**播放中**也能生效的，不用停再重开 ——
    重开会从头上放，观众看到画面跳回去。失败就当没压，不影响画面。
    """
    if not _audio_open:
        return False
    try:
        _mci(f"setaudio {_ALIAS} volume to {max(0, min(1000, int(float(v) * 1000)))}", quiet=True)
        return True
    except OSError:
        return False


# ── 音频轨缓存（视频里的声音要单独抽出来给 MCI）──────────────────────
_CACHE = os.path.join(tempfile.gettempdir(), "dymedia-audio")


def _extract_audio(path, mtime):
    """把视频/音频文件的音轨抽成 wav。抽过就复用（按路径+mtime 命名）。"""
    if not FFMPEG:
        return ""
    os.makedirs(_CACHE, exist_ok=True)
    key = hashlib.sha1(f"{path}|{mtime}".encode("utf-8", "ignore")).hexdigest()[:16]
    out = os.path.join(_CACHE, key + ".wav")
    if os.path.exists(out) and os.path.getsize(out) > 512:
        return out
    try:
        p = subprocess.run(
            [FFMPEG, "-v", "error", "-y", "-i", path, "-vn", "-ac", "2", "-ar", "44100", out],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=25,
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
        if p.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 512:
            return out
    except Exception:  # noqa: BLE001
        pass
    return ""


_AUDIO_PROBE = {}


def _has_audio(path, mtime):
    """这个文件里到底有没有音轨？—— 用来区分「文件本来就没声音」和「抽轨失败」。

    2026-10-27 查「放视频成功了，但是没有声音」时发现：`0-梁圣巡演.mp4`、
    `2-man.mp4`、`4-瑞克摇.mp4` 三个素材**本身就没有音轨**（不是播放链路的锅）。
    以前 `_extract_audio` 抽失败只是静默返回 ""，日志里一个字都没有，看起来像
    MCI 挂了。现在把「没有音轨」这件事明确写出来，省得下次又从头查一遍。

    imageio-ffmpeg 只带 ffmpeg.exe，没有 ffprobe，所以用 `-i` 的 stream info
    去认（stderr 里有没有 `Audio:`）。结果按 路径+mtime 缓存，一个文件只探一次。
    """
    if not FFMPEG:
        return None
    key = hashlib.sha1(f"{path}|{mtime}".encode("utf-8", "ignore")).hexdigest()[:16]
    if key in _AUDIO_PROBE:
        return _AUDIO_PROBE[key]
    got = None
    try:
        p = subprocess.run(
            [FFMPEG, "-hide_banner", "-i", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=20,
            creationflags=0x08000000,
        )
        txt = (p.stderr or b"").decode("utf-8", "ignore")
        got = "Audio:" in txt
    except Exception:  # noqa: BLE001
        got = None
    _AUDIO_PROBE[key] = got
    return got


def _warn(msg):
    """写一行到 stderr（overlay.log 收着）。media.py 跑在画面进程里，没有 logger。"""
    try:
        sys.stderr.write(msg + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


def _fit(im, w, h, bg=(6, 8, 10)):
    """按 contain 缩放并居中，四周补底色。不裁切 —— 宁可留边，也别把内容切掉。"""
    im = im.convert("RGB")
    iw, ih = im.size
    if iw <= 0 or ih <= 0:
        return Image.new("RGB", (w, h), bg)
    k = min(w / iw, h / ih)
    nw, nh = max(1, int(iw * k)), max(1, int(ih * k))
    im = im.resize((nw, nh), Image.LANCZOS if k < 1 else Image.BILINEAR)
    if nw == w and nh == h:
        return im
    canvas = Image.new("RGB", (w, h), bg)
    canvas.paste(im, ((w - nw) // 2, (h - nh) // 2))
    return canvas


class Engine:
    """跟着 /state.json 里的 media 段走：seq 变了就换素材。"""

    def __init__(self):
        self.seq = None
        self.path = ""
        self.kind = ""
        self.name = ""
        self.volume = 1.0
        self.loop = False
        self.max_ms = 0
        self.t0 = 0.0
        self.error = ""

        self._size = (0, 0)

        # 视频
        self._proc = None
        self._frame_bytes = 0
        self._fps = 15
        self._next_at = 0.0
        self._last = None
        self._eof = False

        # 图片 / GIF
        self._frames = []
        self._durs = []
        self._dur_total = 0.0

        # 音频
        self._audio_ok = False
        self._reported = False

    # ---------------------------------------------------------------- 生命周期
    def _close_video(self):
        if self._proc:
            try:
                self._proc.kill()
            except Exception:  # noqa: BLE001
                pass
            self._proc = None

    def close(self, report=False):
        if report and not self._reported and self.seq is not None:
            self._reported = True
            return self.seq
        self._close_video()
        _mci_close()
        self.seq = None
        self.path = ""
        self.kind = ""
        self._frames = []
        self._durs = []
        self._last = None
        self._eof = False
        self._audio_ok = False
        self._reported = False
        return None

    # ------------------------------------------------------------------ 开始播
    def _start(self, m, size):
        self._close_video()
        _mci_close()
        self._size = size
        self.seq = m.get("seq")
        self.path = str(m.get("file") or "")
        self.kind = str(m.get("kind") or "")
        self.name = str(m.get("name") or os.path.basename(self.path))
        self.volume = float(m.get("volume") or 1.0)
        self.loop = bool(m.get("loop"))
        self.max_ms = int(m.get("maxMs") or 15000)
        self.t0 = time.time()
        self.error = ""
        self._frames, self._durs, self._dur_total = [], [], 0.0
        self._last = None
        self._eof = False
        self._reported = False
        self._audio_ok = False
        # True = 素材本身没音轨（不是播放链路的问题）。给上层 / 日志一个明确的区分。
        self.silent = False
        self._next_at = 0.0

        if not self.path or not os.path.exists(self.path):
            self.error = "文件不见了"
            return

        ext = os.path.splitext(self.path)[1].lower()
        try:
            if ext in VIDEO_EXT:
                self._start_video()
            elif ext in AUDIO_EXT:
                self._start_audio()
            else:
                self._start_image(ext)
        except Exception as e:  # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"
            self._frames = []

    def _start_image(self, ext):
        im = Image.open(self.path)
        n = getattr(im, "n_frames", 1)
        if n > 1:
            durs = []
            frames = []
            for i in range(n):
                im.seek(i)
                # 🔴 每一帧都要 fit 到屏幕尺寸再存 —— 原图多大就用多大，
                #    贴到屏幕上会因为尺寸不匹配直接抛「images do not match」。
                frames.append(_fit(im, *self._size))
                durs.append(max(20, int(im.info.get("duration", 90) or 90)) / 1000.0)
            self._frames = frames
            self._durs = durs
            self._dur_total = sum(durs)
            if not self._frames:
                self.error = "动图一帧都读不出来"
        else:
            self._frames = [_fit(im, *self._size)]
            self._durs = []
            self._dur_total = 0.0
        if self.kind == "anim" and len(self._frames) <= 1:
            # 扩展名像动图、其实是单帧（webp 很常见），当静态图用，不报错
            self.kind = "image"

    def _start_audio(self):
        self._audio_ok = _mci_play(self.path, self.volume)
        if not self._audio_ok:
            self.error = "这个音频格式系统放不了（试试 mp3 / wav / m4a）"

    def _start_video(self):
        if not FFMPEG:
            self.error = "没找到 ffmpeg（pip install imageio-ffmpeg）"
            return
        w, h = self._size
        # 音轨单独抽出来给 MCI —— ffmpeg 管道只出画面，不管声音
        mtime = os.path.getmtime(self.path)
        wav = _extract_audio(self.path, mtime)
        if wav:
            self._audio_ok = _mci_play(wav, self.volume)
        else:
            # 没声音的时候要说清楚是哪一种，否则「放视频没声音」永远是个谜
            has = _has_audio(self.path, mtime)
            if has is False:
                _warn(f"  ⓘ {os.path.basename(self.path)} 本身没有音轨 —— 画面正常，声音是素材里就没有")
                self.silent = True
            elif has:
                _warn(f"  ⚠ {os.path.basename(self.path)} 有音轨但抽不出来（ffmpeg 抽轨失败），这次没声音")

        self._fps = 15
        self._frame_bytes = w * h * 3
        vf = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
        secs = max(1, self.max_ms // 1000 + 1)
        cmd = [
            FFMPEG, "-v", "error", "-re", "-i", self.path, "-an",
            "-vf", vf, "-r", str(self._fps),
            "-t", str(secs),
            "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
        ]
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=0x08000000,
        )
        self._next_at = time.time()

    # -------------------------------------------------------------- 每帧要图
    def frame(self, size=None):
        """返回当前该显示的 PIL 图（已经缩到屏幕大小），没有就 None。"""
        if size and size != self._size:
            self._size = size
        if self.error:
            return None
        if not self.path:
            return None

        if self.kind == "video":
            return self._frame_video()
        if self.kind == "audio":
            return None  # 波形由 render.py 画
        if not self._frames:
            return None
        if len(self._frames) == 1:
            return self._frames[0]
        # 动图：按累计时长定位到第几帧
        if self._dur_total <= 0:
            return self._frames[0]
        el = time.time() - self.t0
        if self.loop:
            el %= self._dur_total
        elif el >= self._dur_total:
            el = self._dur_total - 0.001
        acc = 0.0
        for i, d in enumerate(self._durs):
            acc += d
            if el < acc:
                return self._frames[i]
        return self._frames[-1]

    def _frame_video(self):
        now = time.time()
        if self._last is not None and now < self._next_at:
            return self._last  # 还没到下一帧的时间，复用上一帧
        if not self._proc or not self._proc.stdout:
            return self._last
        try:
            buf = self._proc.stdout.read(self._frame_bytes)
        except Exception as e:  # noqa: BLE001
            self.error = f"读帧失败：{e}"
            return self._last
        if not buf or len(buf) < self._frame_bytes:
            self._eof = True
            if self.loop:
                # 循环：重开一个 ffmpeg，从头再来
                self._start_video()
                self.t0 = time.time()
                return self._last
            return self._last
        w, h = self._size
        self._last = Image.frombytes("RGB", (w, h), buf)
        self._next_at = now + 1.0 / max(1, self._fps)
        return self._last

    # ------------------------------------------------------------------ 该收了
    @property
    def animated(self):
        """这一份素材需要逐帧重画吗？

        🔴 静态图**不该**把画面拉到 15fps（2026-10-27）：一张 png 播 30 秒，
           按 15fps 重画就是 450 帧 × 24ms ≈ 11 秒的 CPU，纯属白烧。
           进度条和秒数靠「秒变了才画」就够了。
        """
        if self.seq is None:
            return False
        if self.kind in ("video", "audio"):
            return True
        return len(self._frames) > 1

    def elapsed_ms(self):
        return (time.time() - self.t0) * 1000.0 if self.t0 else 0.0

    def finished(self):
        """自然播完了吗（超时由桥那边兜底，这里只管文件本身放完了）。"""
        if self.seq is None or self.error:
            return False
        if self.kind == "video":
            return self._eof and not self.loop
        if self.kind == "audio":
            if not self._audio_ok:
                return True
            return _mci_mode() != "playing"
        if len(self._frames) <= 1:
            return False  # 静态图 / 单帧：等桥超时
        if self.loop:
            return False
        return self.elapsed_ms() >= self._dur_total * 1000.0

    # ------------------------------------------------------------------ 同步
    def sync(self, m, size):
        """按桥给的 media 段对齐。返回 True 表示换了素材（需要重画）。"""
        if not m or not m.get("cur"):
            if self.seq is not None:
                self.close()
                return True
            return False
        cur = m["cur"]
        seq = cur.get("seq")
        if seq == self.seq:
            # 同一个素材：seq 没变，但**音量可能变了** ——
            # 她说话时桥会把 0 档视频压到 20%，说完恢复。
            # 只调音量，不重开（重开会从头放，画面会跳回去）。
            v = cur.get("volume")
            if v is not None:
                self.set_volume(v)
            return False
        self.close()
        self._start(cur, size)
        return True

    def set_volume(self, v):
        """改当前素材的音量。只对真的有音轨的（视频 / 音频）做。"""
        try:
            v = max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            return
        if abs(v - self.volume) < 0.01:
            return
        self.volume = v
        if self.kind in ("video", "audio"):
            _mci_volume(v)


def wave_bars(t, n, h):
    """音频档用的假波形：不接真频谱，够看就行（省一个 FFT 依赖）。"""
    import math

    out = []
    for i in range(n):
        a = t * 3.1 + i * 0.55
        b = math.sin(a) * 0.5 + math.sin(a * 2.7) * 0.3 + math.sin(a * 0.7) * 0.2
        out.append(max(0.08, min(1.0, 0.45 + b * 0.55)))
    return out
