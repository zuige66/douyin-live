#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""动作帧播放器 —— 让大肥鱼真的动起来

素材从哪儿来：
  QCYTSN/dsh-dafeiyu（MIT）把 PC2005-cloud/dsh-pet 的 AI 生成动画导成了
  16 段透明 WebP 帧序列，共 3444 帧，统一画布 412×344，源 24fps。
  角色和我们 assets/dafeiyu.png 是**同一只**鲸鱼女仆，只是姿势不同。
  用 tools/fetch-pet.mjs 拉，落在 assets/pet/<clip>/<clip>_001.webp。

为什么按 12fps 播而不是 24fps：
  这些动作是呼吸、摇晃这种慢动作，24fps 和 12fps 肉眼几乎分不出来，
  但每秒少解一半的帧。要改：环境变量 ZY_PET_FPS=24。

尺寸怎么定（这块踩过坑，别乱改）：
  1. 不按"帧宽 412 拉到 570"，而是按**角色本身**的 alpha 包围盒定宽 ——
     412 的画布里角色只占 222px，按帧宽拉会让她凭空小一圈。
  2. 只缩**裁出来的那一块**，不缩整帧。整帧 412×344 放大到 1058×883 要 13ms，
     裁到角色那一块再放大只要 4ms，而且贴图位置也算得更准。
  3. 裁切框所有动作共用一个（idle 和各动作包围盒的并集 + 边距），
     否则高兴时跳一下、委屈时矮一截，人会上下乱窜。

素材缺失（没拉帧）时 frame() 返回 None，渲染层退回静态 PNG，不会开天窗。
"""
import os
from collections import OrderedDict

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
PET_DIR = os.path.join(os.path.dirname(HERE), "assets", "pet")

FRAME_MS = 42  # 源 24fps（作者在 animation-behavior.md 里写的运行时 42ms/帧）
FPS = float(os.environ.get("ZY_PET_FPS") or 10)
CACHE_MAX = int(os.environ.get("ZY_PET_CACHE") or 24)  # 一帧约 2.5MB，24 帧 ≈ 60MB
# 为什么要缓存：12fps 播 24fps 的源，每拍前进约 2 帧，正常播放其实不怎么命中。
# 它救的是「同一帧被重画」的情况（WM_PAINT、--capture 抓图），以及偶尔的节拍抖动。
# 别调太大：241 帧全缓存要 600MB，直播时机器还要跑直播伴侣。
MARGIN = 0.06  # 裁切框留边，给尾巴摆动之类的留余量
SHARPEN = os.environ.get("ZY_PET_SHARP") != "0"  # 放大后做一次 3×3 锐化，糊得没那么明显

# 桥那边说"什么心情"，这里换成"播哪一段"
CLIP_OF_MOOD = {
    "idle": "idle",
    "talk": "idle",       # 还没有"说话"素材，先用待机顶着
    "busy": "idle",
    "happy": "success",   # 送礼 / 被夸 → 雀跃
    "gift": "success",
    "sad": "error",       # 被骂 → 委屈
    "error": "error",
    "thinking": "thinking",   # 正在想怎么回（有冒泡）
    "waiting": "waiting",     # 有人进直播间 → 抬头张望
    "yawn": "idle_yawn",      # 冷场 → 打哈欠
    "stretch": "idle_stretch",  # 冷场 → 伸懒腰
    "tail": "tail",
    "poke": "poke",
    "pat": "head_pat",
}

_frames = {}   # clip -> [绝对路径]
_scaled = OrderedDict()  # (path, scale) -> RGBA
_geom = None   # 几何信息（裁切框、缩放、锚点）


def _clip_frames(clip):
    fr = _frames.get(clip)
    if fr is None:
        d = os.path.join(PET_DIR, clip)
        fr = sorted(
            os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".webp")
        ) if os.path.isdir(d) else []
        _frames[clip] = fr
    return fr


def has(clip):
    return bool(_clip_frames(clip))


def available():
    """有没有能用的动作素材（没有就让渲染层退回静态图）

    ZY_PET=0 可以强行关掉动画 —— 想回到以前那张清晰的静态立绘就用它。
    """
    if os.environ.get("ZY_PET") == "0":
        return False
    return has("idle")


def _raw(path):
    """原始帧（已经是 RGBA，别再 convert 一次，那是白拷一份）"""
    im = Image.open(path)
    im.load()
    return im if im.mode == "RGBA" else im.convert("RGBA")


def _alpha_box(im):
    """只按 alpha 量包围盒。

    ⚠️ 不能用 im.getbbox()：素材是抠像来的，透明区域下面还留着原来的 RGB，
       整张图都"非零"，量出来永远是 (0,0,412,344)。必须只看 alpha，
       而且要给阈值 —— 边缘有 1~8 的极淡残留。
    """
    a = im.getchannel("A")
    return a.point(lambda v: 255 if v > 8 else 0).getbbox()


def _union_box():
    """所有已下载动作的包围盒并集（取每段的首帧和中间帧）"""
    box = None
    for clip in CLIP_OF_MOOD.values():
        fr = _clip_frames(clip)
        if not fr:
            continue
        for p in (fr[0], fr[len(fr) // 2]):
            b = _alpha_box(_raw(p))
            if not b:
                continue
            box = b if box is None else (
                min(box[0], b[0]), min(box[1], b[1]),
                max(box[2], b[2]), max(box[3], b[3]),
            )
    return box


def geom():
    """裁切框 + 角色锚点，只算一次"""
    global _geom
    if _geom is not None:
        return _geom
    union = _union_box()
    fr = _clip_frames("idle")
    if not union or not fr:
        return None
    canvas = _raw(fr[0]).size
    # 缩放基准必须用 **idle 自己的** 包围盒，不能用并集：
    # error 那段的尾巴甩得很远，并集宽 273，拿它当分母会让待机时的她凭空小一圈。
    box = _alpha_box(_raw(fr[0])) or union
    mx = int((union[2] - union[0]) * MARGIN)
    my = int((union[3] - union[1]) * MARGIN)
    crop = (
        max(0, union[0] - mx), max(0, union[1] - my),
        min(canvas[0], union[2] + mx), min(canvas[1], union[3] + my),
    )
    _geom = {
        "canvas": canvas,
        "crop": crop,
        "char_w": box[2] - box[0],
        "char_h": box[3] - box[1],
        # 角色在裁切块里的位置（后面按 scale 放大）
        "ox": box[0] - crop[0],
        "oy": box[1] - crop[1],
        "foot": box[3] - crop[1],
    }
    return _geom


def scale_for(char_w):
    g = geom()
    return char_w / g["char_w"] if g else 1.0


def frame(clip, t, char_w):
    """取 clip 在 t 秒处的一帧，按「角色宽 char_w」缩放好的 RGBA；缺素材返回 None"""
    g = geom()
    fr = _clip_frames(clip)
    if not fr:
        # 🔴 2026-10-27 踩过：mood 指到一段没下帧的动作（比如 yawn），
        #    这里返回 None，渲染层就什么都不贴 —— 直播里表现成「大肥鱼突然没了」。
        #    缺素材一律退回 idle，宁可动作不对，也不能让人凭空消失。
        fr = _clip_frames("idle")
    if not g or not fr:
        return None
    s = char_w / g["char_w"]
    path = fr[int(t * 1000 / FRAME_MS) % len(fr)]
    key = (path, round(s, 4))
    im = _scaled.get(key)
    if im is not None:
        _scaled.move_to_end(key)
        return im

    raw = _raw(path).crop(g["crop"])
    out = raw.resize(
        (max(1, int(round(raw.width * s))), max(1, int(round(raw.height * s)))),
        Image.LANCZOS,
    )
    if SHARPEN:
        # 角色源只有 222px，放到 570px 是 2.57 倍放大，不锐化就是一团糊。
        # 只锐化 RGB、alpha 原样保留 —— 连 alpha 一起锐化会在轮廓外啃出白边。
        # 实测：先放大再锐化 20.7ms（明显更脆），先锐化再放大 8.8ms（边缘发脏）。
        # 这里是"先放大再锐化"，值这个钱。
        r, gch, b, a = out.split()
        rgb = Image.merge("RGB", (r, gch, b)).filter(ImageFilter.SHARPEN)
        out = Image.merge("RGBA", (*rgb.split(), a))
    _scaled[key] = out
    while len(_scaled) > CACHE_MAX:
        _scaled.popitem(last=False)
    return out


def place(char_w, width=1920, bottom=126, cx=None):
    """这一帧该贴在哪儿：返回 (x, y, 缩放比)

    cx/bottom 是**角色本身**的中心 x 和脚底 y（不是贴图框的），
    这样换动作、换缩放，站位都不会漂。
    """
    g = geom()
    if not g:
        return None
    s = char_w / g["char_w"]
    cx = width / 2.0 if cx is None else cx
    char_cx_in_crop = g["ox"] + g["char_w"] / 2.0
    x = cx - char_cx_in_crop * s
    y = bottom - g["foot"] * s
    return int(round(x)), int(round(y)), s


def clip_for(mood):
    """心情 → 动作段名。**没下帧的一律退回 idle**，绝不返回空段名。"""
    name = CLIP_OF_MOOD.get(str(mood or "idle"), "idle")
    return name if has(name) else "idle"


def duration(clip):
    fr = _clip_frames(clip)
    return len(fr) * FRAME_MS / 1000.0 if fr else 0.0


def warm(clips=("idle",)):
    """预热：把这几段的前若干帧解出来，开播头几秒不会卡一下"""
    for c in clips:
        for i in range(8):
            frame(c, i / FPS, 570)
