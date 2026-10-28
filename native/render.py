#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""zuige大肥鱼 直播画面 · 原生渲染器（PIL 合成）

为什么不用浏览器：Chromium 的渲染进程在这台机器上每 33 秒就 abort() 一次，
而崩溃前的遥测显示 JS 堆只有 0.6MB、页面完全静止——跟页面内容无关。
这个文件用 Pillow 直接把画面画出来，一个进程、无 GPU、无渲染进程，
空闲时 CPU 大约 0。

分两层：
  build_base()  静态部分（辉光/主播牌/卡片/皮套/固定文字）只合成一次，缓存
  compose()     逐帧只画会变的东西（数字/状态点/弹幕/字幕），十几毫秒

硬约束：抖音直播伴侣只能 16:9，所以固定 1920×1080。

用法：
  python render.py --shot out.png     # 出一张静态图，调版式用
  python render.py --bench            # 量合成耗时
"""
import sys
import time
import os
import json
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import pet  # 动作帧播放器（native/pet.py）；没有素材时它自己会说不可用

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

W, H = 1920, 1080
SS = 2  # 静态层超采样倍数：先按 2 倍画再缩回去，圆角和图才不毛糙

# ── 配色：M3 Expressive 深色 + 紫（2026-10-27 晚：「用 m3e 的紫色优雅一点」）──
# 数值全部取自 Material 3 深色方案的标准 role，不自己挑紫 —— 这样"紫"才是 M3 的紫，
# 而不是随便一个紫。改色请对着 role 改，别凭感觉报色号。
#   surface              #141218   画面底
#   surfaceContainerLow  #1D1B20   屏幕待机底
#   surfaceContainer     #211F26   卡片
#   surfaceContainerHigh #2B2930   显示器外壳
#   onSurface            #E6E1E5   正文
#   onSurfaceVariant     #CAC4D0   次要文字
#   primary              #D0BCFF   强调紫
#   tertiary             #EFB8C8   藕粉
#   outlineVariant       #49454F   描边
INK = (230, 225, 229, 255)    # onSurface
DIM = (202, 196, 208, 255)    # onSurfaceVariant
PRI = (208, 188, 255, 255)    # primary（替掉原来的青 TEAL）
TER = (239, 184, 200, 255)    # tertiary（替掉原来的金 GOLD）
BG = (30, 24, 42, 255)        # surface，往紫里偏了一点：#17131F
CARD = (46, 38, 63, 255)      # surfaceContainer：卡片实色，全不透明
FAINT = (202, 196, 208, 128)  # 次要信息：onSurfaceVariant 半透明
HAIR = (92, 79, 120, 255)     # outlineVariant 偏紫：卡片 1px 描边（实色）
ON_PRI = (56, 30, 114, 255)   # 画在 primary 底色上的字（浅色主题下会变白，见 _PALETTE）

# 2026-10-27 晚提亮：主人说「整个画面都是挺暗的」。
# 原来 BG(7,9,12) 几乎是纯黑、正文 233、次要文字 142 —— 在抖音直播伴侣里
# 叠一层压缩之后再暗一档，手机上看就糊成一片。整体抬一档：
#   BG 7→21（深蓝灰，不是死黑）· INK 233→246 · DIM 142→180
#   FAINT 透明度 87→112 · HAIR 26→36
# 只动亮度和卡片底色，不动色相（teal/gold/pink 原样）。

F_REG = "C:/Windows/Fonts/msyh.ttc"
F_BOLD = "C:/Windows/Fonts/msyhbd.ttc"

# 版式常量（1920×1080 坐标系）
# 2026-10-27 晚：主人要求去掉左上角那张「头像 + zuige大肥鱼 + 状态点」的主播牌，
# 把「本场数据」卡片顶到最左上角 —— 所以 CARD_Y 从 236 挪到 54，整条左栏上移 182px。
# BRAND_X / BRAND_Y / AV 已经没人用了（face_disc / ring 两个工具函数留着，
# 以后想加回头像直接调用就行，不占运行时开销 —— 它们是惰性加载的）。
CARD_X, CARD_Y, CARD_W = 64, 54, 452
CHAR_W, CHAR_BOTTOM = 570, 126
DM_RIGHT, DM_MAXW, DM_BOTTOM = W - 64, 470, H - 206
DM_NAMEW = 140  # 昵称最多占多宽（约 6 个汉字），超了截断，把地方留给正文
SUB_W, SUB_H, SUB_BOTTOM = 900, 86, 34

# ── 礼物档位「电脑」展示区（2026-10-27 加，替掉右侧弹幕列）─────────────
# 版式：右栏只有一台漫画风显示器，屏幕里放素材。全部坐标是 1920×1080。
#
# 🔴 尺寸是倒着算出来的，别随手改：显示器底边必须落在 NECK_Y（脖子顶），
#    底座压在 FOOT_Y；显示器**上边**要给「正在播放」那两行说明留 84px。
#    2026-10-27 晚：主人说上方那张「礼物媒体」队列卡不用了，删掉之后
#    显示器从 496×279 放大到 560×315，把空出来的地方吃掉一部分。
SCR_W, SCR_H = 560, 315                      # 屏幕可视区（16:9）
BEZ = 17                                     # 屏幕边框厚度
MON_W, MON_H = SCR_W + BEZ * 2, SCR_H + BEZ * 2   # 594 × 349
MON_RIGHT = W - 64                           # 1856
MON_X = MON_RIGHT - MON_W                    # 1262
FOOT_Y = H - 206 - 14                        # 860  底座顶边
NECK_Y = FOOT_Y - 26                         # 834  脖子顶边 = 显示器底边
MON_Y = NECK_Y - MON_H                       # 485
SCR_X, SCR_Y = MON_X + BEZ, MON_Y + BEZ      # 1279, 502
CAP_Y = MON_Y - 84                           # 401  「正在播放」那两行的基线

# 想看回弹幕列就设 ZY_DANMAKU=1（代码留着，只是默认不画）
DANMAKU_ON = os.environ.get("ZY_DANMAKU", "0") == "1"

# ══════════════════════════════════════════════════════════════════════════
# 版式：cache/layout.json（2026-10-28 加）
#
# 为什么要这个文件：画面是 Pillow 画的，editor.html 里拖出来的坐标传不进
# Python 的常量。两边约一份 JSON 当合同 —— 编辑器写它，这里读它。
#
# 🔴 只外置「位置 + 宽度」。高度一律由内容算（见 comp_h）：
#    卡片高度是倒推出来的（点歌台 = 正在播放 + 3 首 + 提示两行），
#    放开高度就会出现"拖矮了文字叠成一团"。
#
# 🔴 文件读不到 / 内容坏了 → 用默认版式，绝不黑屏。
#    直播中没人盯着控制台，所以这里一律 print 到 stderr 后继续跑。
# ══════════════════════════════════════════════════════════════════════════
LAYOUT_FILE = os.path.join(os.path.dirname(HERE), "cache", "layout.json")

# 弹幕列的底边（原来 DM_BOTTOM 的位置）。弹幕自底向上排，所以它的 y 是顶边，
# 高度 = 底边 - 顶边 —— 拖 y 就是「能显示几条」。
DM_FLOOR = H - 206

# 皮套原图比例（assets/dafeiyu.png = 1005×1078）。宽度定了高度就定了。
CHAR_RATIO = 1078.0 / 1005.0
# 显示器整体比例：屏幕 560×315 + 边框 + 脖子 + 底座 = 594×389
MON_RATIO = 389.0 / 594.0


# 两套配色（2026-10-28 加）：layout.json 里 "theme": "dark" | "light"。
# 为什么要有 light：主人换的这张广工蓝底是浅色的，深紫卡片压上去像贴纸，
# 浅紫标语（#D0BCFF）在浅蓝上几乎看不见。深色主题是原来的默认，一个字没动。
_PALETTE = {
    "dark": {
        "INK": (230, 225, 229, 255),    # onSurface
        "DIM": (202, 196, 208, 255),    # onSurfaceVariant
        "FAINT": (202, 196, 208, 128),
        "PRI": (208, 188, 255, 255),    # primary
        "TER": (239, 184, 200, 255),    # tertiary
        "CARD": (46, 38, 63, 255),      # surfaceContainer
        "HAIR": (92, 79, 120, 255),     # outlineVariant
        "ON_PRI": (56, 30, 114, 255),   # 画在 primary 底色上的字
    },
    "light": {
        "INK": (27, 27, 31, 255),
        "DIM": (68, 70, 79, 255),
        "FAINT": (68, 70, 79, 190),     # 浅底上 140 太淡，右下角那两行看不清
        "PRI": (79, 55, 139, 255),
        "TER": (125, 82, 96, 255),
        "CARD": (255, 255, 255, 255),
        "HAIR": (202, 196, 208, 255),
        "ON_PRI": (255, 255, 255, 255),
    },
}


def _layout_default():
    """默认版式 = 2026-10-27 那一套硬编码坐标，一格不差。
    这样 layout.json 丢了，画面也还是主人熟悉的样子。"""
    return {
        "version": 1,
        "theme": "dark",
        "bg": {"type": "image", "image": "assets/bg-gdut.png",
               "color": "#17131F", "dim": 0.0},
        "items": {
            "stats":     {"x": 64,   "y": 54,   "w": 452, "visible": True},
            "songs":     {"x": 64,   "y": 294,  "w": 452, "visible": True},
            "banner":    {"x": 700,  "y": 26,   "w": 520, "visible": True,
                          "size": 50, "align": "center"},
            "character": {"x": 675,  "y": 343,  "w": 570, "visible": True},
            "monitor":   {"x": 1262, "y": 485,  "w": 594, "visible": True},
            "danmaku":   {"x": 1386, "y": 180,  "w": 470, "visible": False},
            "subtitle":  {"x": 510,  "y": 960,  "w": 900, "visible": True},
        },
    }


def comp_h(name, x, y, w):
    """组件的「自适应高度」。编辑器里也按这套公式画框（改这里要同步 editor.html）。
    ⚠️ 只有 danmaku 跟 y 有关（自底向上排），其余只跟宽度有关或干脆固定。"""
    if name == "stats":
        return 216                      # 32 + 36 + 3×46 + 10
    if name == "songs":
        return 478                      # 32+36+114+3×58+78+44（有歌手时）
    if name == "banner":
        return 64
    if name == "character":
        return int(round(w * CHAR_RATIO))
    if name == "monitor":
        return int(round(w * MON_RATIO))
    if name == "danmaku":
        return max(80, DM_FLOOR - y)
    if name == "subtitle":
        return 86
    return 100


_LAYOUT = None
_LAYOUT_MT = None
_LAYOUT_STAMP = None
_LAYOUT_NEXT_CHECK = 0.0

# 各组件显隐（编辑器里的「眼睛」）
VIS = {}


def layout():
    """读 layout.json。0.5 秒最多 stat 一次 —— 逐帧调用它也不能拖慢 compose。"""
    global _LAYOUT, _LAYOUT_MT, _LAYOUT_STAMP, _LAYOUT_NEXT_CHECK
    now = time.time()
    if _LAYOUT is not None and now < _LAYOUT_NEXT_CHECK:
        return _LAYOUT
    _LAYOUT_NEXT_CHECK = now + 0.5
    try:
        mt = os.path.getmtime(LAYOUT_FILE)
    except OSError:
        if _LAYOUT is None:
            _LAYOUT = _layout_default()
            _LAYOUT_STAMP = ("default",)
            print(f"[layout] 没有 {LAYOUT_FILE}，用默认版式", file=sys.stderr)
        return _LAYOUT
    if _LAYOUT is not None and mt == _LAYOUT_MT:
        return _LAYOUT
    try:
        with open(LAYOUT_FILE, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        if not isinstance(data, dict):
            raise ValueError("顶层必须是对象")
        base = _layout_default()
        # ⚠️ 顶层字段要逐个搬。2026-10-28 第一次就漏了 theme：
        #    编辑器里切了浅色、画面纹丝不动，而且完全不报错 —— 最难查的那种。
        if data.get("theme") in _PALETTE:
            base["theme"] = data["theme"]
        base["bg"] = dict(base["bg"], **(data.get("bg") or {}))
        items = dict(base["items"])
        for k, v in (data.get("items") or {}).items():
            if isinstance(v, dict):
                items[k] = dict(items.get(k) or {}, **v)
        base["items"] = items
        _LAYOUT = base
        _LAYOUT_MT = mt
        bg = base["bg"]
        _LAYOUT_STAMP = (mt, base.get("theme"), bg.get("type"), bg.get("image"),
                         bg.get("color"), bg.get("dim"))
    except Exception as e:
        # 🔴 半截写入（编辑器正在存）也会走到这儿。绝不能因此换版式：
        #    留在上一份能用的，等下一次 mtime 变了再试。
        print(f"[layout] 读不了（{type(e).__name__}: {e}），继续用上一份",
              file=sys.stderr)
        if _LAYOUT is None:
            _LAYOUT = _layout_default()
            _LAYOUT_STAMP = ("broken",)
        _LAYOUT_MT = mt
    return _LAYOUT


def apply_layout():
    """把 layout.json 的 x/y/w 写回模块级常量。

    为什么改全局而不是把常量一路传参：这些数字在 build_base / draw_computer /
    compose 里被引用了几十处，改签名等于把 900 行全动一遍，风险远大于收益。
    这里一次性覆盖，原代码一个字不用改。
    """
    global CARD_X, CARD_Y, CARD_W, SONG_X, SONG_Y, SONG_W
    global BANNER_X, BANNER_Y, BANNER_W, BANNER_SIZE, BANNER_ALIGN
    global CHAR_X, CHAR_Y, CHAR_W, CHAR_H, CHAR_BOTTOM
    global MON_X, MON_Y, MON_W, MON_H, MON_K, BEZ
    global SCR_X, SCR_Y, SCR_W, SCR_H, NECK_Y, FOOT_Y, CAP_Y
    global DM_RIGHT, DM_MAXW, DM_BOTTOM
    global SUB_X, SUB_Y, SUB_W, SUB_H, SUB_BOTTOM
    global INK, DIM, FAINT, PRI, TER, CARD, HAIR, ON_PRI
    global VIS, _LAY_BOX

    L = layout()
    it = L.get("items") or {}

    # 配色：主题变了就整套换（卡片/文字/强调色都是全局，一处改完所有绘制跟着变）
    pal = _PALETTE.get(str(L.get("theme") or "dark"), _PALETTE["dark"])
    INK = pal["INK"]; DIM = pal["DIM"]; FAINT = pal["FAINT"]
    PRI = pal["PRI"]; TER = pal["TER"]; CARD = pal["CARD"]
    HAIR = pal["HAIR"]; ON_PRI = pal["ON_PRI"]

    def g(name, dx, dy, dw):
        c = it.get(name) or {}
        try:
            x = int(c.get("x", dx)); y = int(c.get("y", dy))
            w = int(c.get("w", dw))
        except (TypeError, ValueError):
            x, y, w = dx, dy, dw
        return x, y, max(120, w)

    VIS = {k: bool((v or {}).get("visible", True)) for k, v in it.items()}

    CARD_X, CARD_Y, CARD_W = g("stats", 64, 54, 452)
    SONG_X, SONG_Y, SONG_W = g("songs", 64, 294, 452)

    BANNER_X, BANNER_Y, BANNER_W = g("banner", 700, 26, 520)
    b = it.get("banner") or {}
    try:
        BANNER_SIZE = max(12, int(b.get("size", 50)))
    except (TypeError, ValueError):
        BANNER_SIZE = 50
    BANNER_ALIGN = str(b.get("align") or "center")

    CHAR_X, CHAR_Y, CHAR_W = g("character", 675, 343, 570)
    CHAR_H = comp_h("character", CHAR_X, CHAR_Y, CHAR_W)
    CHAR_BOTTOM = H - (CHAR_Y + CHAR_H)   # 老代码还按「距底多少」算，保留

    MON_X, MON_Y, MON_W = g("monitor", 1262, 485, 594)
    MON_K = MON_W / 594.0                 # 显示器整体等比缩放系数
    MON_H = int(round(349 * MON_K))
    BEZ = max(8, int(round(17 * MON_K)))
    SCR_W, SCR_H = MON_W - 2 * BEZ, MON_H - 2 * BEZ
    SCR_X, SCR_Y = MON_X + BEZ, MON_Y + BEZ
    NECK_Y = MON_Y + MON_H
    FOOT_Y = NECK_Y + int(round(26 * MON_K))
    CAP_Y = MON_Y - 84                    # 显示器上方「正在播放」两行

    d_x, d_y, d_w = g("danmaku", 1386, 180, 470)
    DM_MAXW = d_w
    DM_RIGHT = d_x + d_w
    DM_BOTTOM = DM_FLOOR

    SUB_X, SUB_Y, SUB_W = g("subtitle", 510, 960, 900)
    SUB_H = 86
    SUB_BOTTOM = H - (SUB_Y + SUB_H)      # 老代码按「距底」算，保留兼容

    # 半透明图层的裁剪范围跟着显示器走（见 _lay()）
    _LAY_BOX = (MON_X - 24, CAP_Y - 16, min(W, MON_X + MON_W + 24), FOOT_Y + 44)

TIER_COL = {
    # 0 档是「闲时素材」，不是礼物 —— 用中性青灰，别和礼物档抢颜色。
    0: (147, 143, 153, 255),  # 闲时 · outline 灰紫，不是礼物，别抢镜头
    1: (208, 188, 255, 255),  # 小额 · primary 淡紫
    2: (239, 184, 200, 255),  # 中额 · tertiary 藕粉
    3: (244, 212, 175, 255),  # 大额 · 香槟（和紫搭在一起显贵，不用纯金）
    4: (255, 176, 196, 255),  # 特效 · 玫红（比 tertiary 更艳，只有这一档用）
}

_fonts = {}


def font(size, bold=False, ss=True):
    key = (size, bold, ss)
    f = _fonts.get(key)
    if f is None:
        f = ImageFont.truetype(F_BOLD if bold else F_REG, int(size * (SS if ss else 1)))
        _fonts[key] = f
    return f


def text_w(d, s, f):
    """量文字宽度；f 是 SS 倍字体时结果也要 /SS"""
    return d.textlength(s, font=f)


_MEAS = None


def fit_text(s, max_w, size, bold=False):
    """超宽就截断加省略号。

    按**像素**量而不是按字数猜 —— 中英文混排字数完全不准
    （「I Really Like You」13 个字符比「这首歌真的很好听」8 个汉字还宽）。
    """
    global _MEAS
    s = str(s or "")
    if not s:
        return s
    fnt = font(size, bold, ss=False)
    if _MEAS is None:
        _MEAS = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    if _MEAS.textlength(s, font=fnt) <= max_w:
        return s
    ell = "…"
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _MEAS.textlength(s[:mid] + ell, font=fnt) <= max_w:
            lo = mid
        else:
            hi = mid - 1
    return s[:lo] + ell if lo else ell


# ---------------------------------------------------------------- 背景辉光
# 目前没有调用点：背景改成纯色之后退役了（2026-10-27）。留着是因为
# 以后要做局部发光（比如礼物特效）还能直接用，不用再写一遍极坐标循环。
def _glow(size, color, radius_ratio=0.62):
    """低分辨率画径向渐变再放大，比逐像素快得多"""
    sw, sh = 96, 54
    g = Image.new("L", (sw, sh), 0)
    px = g.load()
    cx, cy = sw / 2.0, sh / 2.0
    for y in range(sh):
        for x in range(sw):
            dx = (x - cx) / (sw / 2.0)
            dy = (y - cy) / (sh / 2.0)
            v = max(0.0, 1.0 - (dx * dx + dy * dy) ** 0.5 / radius_ratio)
            px[x, y] = int(255 * v * v)
    g = g.resize(size, Image.BILINEAR)
    layer = Image.new("RGBA", size, color[:3] + (0,))
    layer.putalpha(g.point(lambda a: int(a * color[3] / 255)))
    return layer


_BG = None
_BG_KEY = None


def _hex(s, default=(23, 19, 31)):
    """'#17131F' → (23,19,31,255)。写错就退回 default，绝不抛。"""
    t = str(s or "").strip().lstrip("#")
    if len(t) == 3:
        t = "".join(ch * 2 for ch in t)
    if len(t) != 6:
        return tuple(default[:3]) + (255,)
    try:
        return (int(t[0:2], 16), int(t[2:4], 16), int(t[4:6], 16), 255)
    except ValueError:
        return tuple(default[:3]) + (255,)


def _bg_image(rel):
    """背景图按 cover 裁到 1920×1080。找不到/打不开就返回 None（调用方退回纯色）。"""
    if not rel:
        return None
    p = rel if os.path.isabs(rel) else os.path.join(os.path.dirname(HERE), rel)
    if not os.path.exists(p):
        p2 = os.path.join(HERE, rel)      # 也有人写成相对 native/ 的
        if not os.path.exists(p2):
            print(f"[layout] 背景图找不到：{rel}", file=sys.stderr)
            return None
        p = p2
    try:
        im = Image.open(p).convert("RGB")
    except Exception as e:
        print(f"[layout] 背景图打不开（{type(e).__name__}: {e}）", file=sys.stderr)
        return None
    tw, th = W * SS, H * SS
    s = max(tw / im.width, th / im.height)      # cover：铺满，多出来的裁掉
    im = im.resize((max(1, int(im.width * s + 0.5)),
                    max(1, int(im.height * s + 0.5))), Image.LANCZOS)
    l = (im.width - tw) // 2
    t = (im.height - th) // 2
    return im.crop((l, t, l + tw, t + th)).convert("RGBA")


def background():
    global _BG, _BG_KEY
    # 背景现在由 layout.json 决定（2026-10-28）：可以是一张图，也可以是纯色。
    # 2026-10-27 晚主人要求过「纯色，不要灯光熏晕」，但 10-28 给了张 1920×1080
    # 的底图要换上 —— 所以两种都留着，默认走图片，改一个字段就回纯色。
    b = (layout().get("bg") or {})
    key = (b.get("type"), b.get("image"), b.get("color"), b.get("dim"))
    if _BG is not None and _BG_KEY == key:
        return _BG
    img = None
    if str(b.get("type") or "color") == "image":
        img = _bg_image(b.get("image"))
    if img is None:
        img = Image.new("RGBA", (W * SS, H * SS), _hex(b.get("color"), BG[:3]))
    else:
        try:
            dim = max(0.0, min(0.9, float(b.get("dim") or 0)))
        except (TypeError, ValueError):
            dim = 0.0
        if dim > 0:
            # 压暗：浅色底图上压深色卡片会"浮"起来，加一层黑纱把层次落下去
            img = Image.blend(img, Image.new("RGBA", img.size, (0, 0, 0, 255)), dim)
    _BG = img
    _BG_KEY = key
    return _BG


# ------------------------------------------------------------ 资源缓存
_CHAR = None
_CHAR_SCALED = {}
_FACE = None


def character(width):
    """皮套图按目标宽度缩放一次就缓存住——之前每帧 LANCZOS 是最大的开销"""
    global _CHAR
    if _CHAR is None:
        _CHAR = Image.open(os.path.join(ASSETS, "dafeiyu.png")).convert("RGBA")
    if width not in _CHAR_SCALED:
        h = int(_CHAR.height * width / _CHAR.width)
        _CHAR_SCALED[width] = _CHAR.resize((width * SS, h * SS), Image.LANCZOS)
    return _CHAR_SCALED[width]


_FACE_DISC = {}


def face_disc(diameter):
    global _FACE
    if diameter in _FACE_DISC:
        return _FACE_DISC[diameter]
    if _FACE is None:
        _FACE = Image.open(os.path.join(ASSETS, "dafeiyu-face.png")).convert("RGBA")
    size = diameter * SS
    img = _FACE.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    _FACE_DISC[diameter] = out
    return out


_RING = {}


def ring(diameter, grow=9, color=(70, 224, 192, 90), w=2):
    key = (diameter, grow, color, w)
    if key in _RING:
        return _RING[key]
    side = (diameter + grow * 2) * SS
    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse((0, 0, side - 1, side - 1), outline=color, width=w * SS)
    _RING[key] = img
    return img


_PATCH = {}


def ground_shadow(w, h, alpha=96):
    """皮套脚下的软阴影，不然人物像是浮在半空"""
    key = (w, h, alpha)
    p = _PATCH.get(key)
    if p is None:
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        ImageDraw.Draw(im).ellipse((0, 0, w - 1, h - 1), fill=(0, 0, 0, alpha))
        p = im.filter(ImageFilter.GaussianBlur(max(3, h // 4)))
        _PATCH[key] = p
    return p


def rr_patch(w, h, r, fill, outline=None, width=1):
    """圆角矩形贴片：在 SS 倍下画好再缩回来，避开 1x 的锯齿边缘。
    按 (尺寸, 颜色) 缓存，弹幕气泡宽度量化到 4px，命中率很高。

    ⚠️ 贴的时候**必须带 alpha 遮罩**（`img.paste(p, xy, p)`）：
       2026-10-26 的「白色边框很丑」就是漏了它 ——
       outline=(255,255,255,26) 这种 10% 的白描边被当成**不透明纯白**贴上去，
       截图里量出来是 (255,255,255) 满值。圆角外侧也一起变成死黑。
    """
    key = (w, h, r, fill, outline, width)
    p = _PATCH.get(key)
    if p is None:
        big = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
        ImageDraw.Draw(big).rounded_rectangle(
            (0, 0, w * SS - 1, h * SS - 1),
            radius=r * SS, fill=fill, outline=outline,
            width=max(1, width * SS),
        )
        p = big.resize((w, h), Image.BOX)
        if len(_PATCH) > 400:  # 防止长跑积累
            _PATCH.clear()
        _PATCH[key] = p
    return p


_SHADOW = {}


def shadow_patch(w, h, r, blur=9, alpha=120):
    """气泡底下的一层柔影。

    去掉白描边之后，气泡和深色背景之间会糊成一片 —— 靠这层影把它托起来，
    比描边干净得多（描边在视频转码后最容易出锯齿）。
    """
    key = (w, h, r, blur, alpha)
    p = _SHADOW.get(key)
    if p is None:
        pad = blur * 2
        big = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(big).rounded_rectangle(
            (pad, pad, pad + w - 1, pad + h - 1), radius=r, fill=(0, 0, 0, alpha)
        )
        p = big.filter(ImageFilter.GaussianBlur(blur * 0.55))
        if len(_SHADOW) > 200:
            _SHADOW.clear()
        _SHADOW[key] = p
    return p, blur * 2


def blit(img, patch, x, y):
    """带 alpha 遮罩贴图 —— 别再用不带遮罩的 paste。"""
    img.paste(patch, (int(x), int(y)), patch)


# ---------------------------------------------------------------- 静态层
_BASE = None
_BASE_KEY = None


def base_key(st):
    # ⚠️ 正在播的歌一变，静态层必须重建 —— 歌名是画在静态层里的。
    #    漏了这两项的表现是「换歌了但画面还显示上一首」，很难查。
    mus = st.get("music") or {}
    # 点歌台只显示歌名（不带歌手），所以 key 里也只放歌名。
    # ⚠️ 不能只放 len()：三首歌往后滚一位，长度还是 3，画面会一直卡在旧歌名上。
    songs = st.get("songs") or ()
    songs_key = tuple(
        str(x if isinstance(x, str) else (x[0] if x else "")) for x in songs
    )
    # 热榜不上面（2026-10-28）：它的歌名既不显示，就别让它参与静态层 key ——
    # 否则热榜每换一首都要重建整张静态层，白烧 CPU，画面还会闪一下。
    shown_title = "" if mus.get("hot") else (mus.get("title") or "")
    return (
        # 版式变了（编辑器里拖过 / 换了背景）必须重建静态层 —— 坐标是画死在图上的。
        # _LAYOUT_STAMP 在 layout() 里更新，base() 会先调 apply_layout()。
        _LAYOUT_STAMP,
        # name 不再参与静态层：主播牌已经删了（2026-10-27 晚），
        # 还留着这一项只会让「改昵称」白重建一次静态层。
        songs_key,
        int(((st.get("queue") or {}).get("total")) or 0),
        shown_title,
        bool(mus.get("playing")),
    )


def build_base(st):
    """画一遍所有不会变的东西，缩到 1920×1080 RGB 存着"""
    img = background().copy()
    d = ImageDraw.Draw(img)
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))  # 半透明元件走单独一层再叠，才有真混合
    ld = ImageDraw.Draw(lay)

    def T(x, y, s, size, color, bold=False, anchor="la"):
        ld.text((x * SS, y * SS), s, font=font(size, bold), fill=color, anchor=anchor)

    if VIS.get("stats", True):
        # ---- 左上：本场数据（原来上面还有一张主播牌，2026-10-27 晚按主人要求删掉）----
        rows = [("收到弹幕", TER), ("收到礼物", None), ("已回复", TER)]
        c1h = 32 + 36 + len(rows) * 46 + 10
        ld.rounded_rectangle(
            (CARD_X * SS, CARD_Y * SS, (CARD_X + CARD_W) * SS, (CARD_Y + c1h) * SS),
            radius=24 * SS, fill=CARD, outline=HAIR, width=SS,
        )
        px, py = CARD_X + 30, CARD_Y + 30
        T(px, py, "本场数据", 25, DIM)
        T(CARD_X + CARD_W - 30, py, "实时", 22, FAINT, anchor="ra")
        ry = py + 60
        for label, _ in rows:
            T(px, ry, label, 27, DIM)
            ry += 46

    if VIS.get("songs", True):
        # 点歌台自己一套坐标：2026-10-28 起它能被编辑器单独拖动，
        # 不再跟「本场数据」卡绑在一起（原来 c2y 是从 CARD_Y 推的）。
        SX, SY, SW = SONG_X, SONG_Y, SONG_W
        px = SX + 30
        songs = st.get("songs") or []
        # 正在播的歌。**热榜不显示**（2026-10-28 主人要求）：
        # 「热歌不用显示出来，后台播放就行」—— 所以 hot=true 时整块"正在播放"都不占位，
        # 观众看到的永远只有「谁点的歌」。
        mus = st.get("music") or None
        if (mus or {}).get("hot"):
            mus = None
        np_title = fit_text((mus or {}).get("title"), SW - 76, 28, bold=True)
        np_by = fit_text((mus or {}).get("artist"), SW - 76, 21)
        np_playing = bool((mus or {}).get("playing"))
        np_h = (114 if np_by else 88) if np_title else 0

        c2y = SY
        # +78 是底部那两行「点歌格式 / 点歌，歌名，歌手（可不填）」，见下面 draw 部分。
        #   （2026-10-27 晚：主人说这两行「太小太暗看不清」，字号 20/23 → 22/28，
        #    颜色 FAINT/DIM → DIM/INK，所以这里的高度预算从 62 抬到 78。）
        # 最后那个 +32 是底部留白 —— 原来 +18 时提示行的字几乎贴着卡片下边缘（实测只剩 5px）。
        c2h = 32 + 36 + np_h + max(len(songs), 1) * 58 + 78 + 44
        ld.rounded_rectangle(
            (SX * SS, c2y * SS, (SX + SW) * SS, (c2y + c2h) * SS),
            radius=24 * SS, fill=CARD, outline=HAIR, width=SS,
        )
        T(px, c2y + 30, "点歌台", 25, DIM)
        q_total = int(((st.get("queue") or {}).get("total")) or 0)
        if q_total > 1:
            T(SX + SW - 30, c2y + 30, f"歌单 {q_total} 首", 22, FAINT, anchor="ra")
        sy = c2y + 88

        if np_title:
            # 「正在播放」一条。音柱只在真在放的时候亮，暂停时压成一条灰线，
            # 不然观众会以为卡住了。
            # ⚠️ 别用 ♪ / ♫ 这类符号：思源黑体里没有，会渲染成豆腐块（实测过）。
            #    小圆点自己画，一定不会缺字。
            ld.ellipse(((px + 3) * SS, (sy + 9) * SS, (px + 13) * SS, (sy + 19) * SS), fill=PRI)
            T(px + 24, sy + 2, "正在播放", 21, FAINT)
            for j, hh in enumerate((10, 18, 13, 20) if np_playing else (5, 5, 5, 5)):
                bx = SX + SW - 30 - (4 - j) * 9
                ld.rounded_rectangle(
                    (bx * SS, (sy + 24 - hh) * SS, (bx + 5) * SS, (sy + 24) * SS),
                    radius=3 * SS, fill=PRI if np_playing else FAINT,
                )
            T(px, sy + 30, np_title, 28, INK, bold=True)
            if np_by:
                T(px, sy + 68, np_by, 21, DIM)
            # 和下面的排队列表隔一条线，不然「艺人名」和「第 1 首」会粘在一起
            ld.rectangle(
                (px * SS, (sy + np_h - 16) * SS, (px + SW - 60) * SS, (sy + np_h - 15) * SS),
                fill=(255, 255, 255, 20),
            )
            sy += np_h

        if not songs:
            # 2026-10-28：列表现在**只放观众点的歌**，热榜不进画面。
            # 所以空列表是正常状态（没人点歌），不是"读不到"。
            T(px, sy + 6, "还没人点歌，随便放着呢", 24, FAINT)
            # 🔴 sy 必须往前挪一格（2026-10-27）：c2h 里按 max(len(songs),1)*58 算高度，
            #    这里不挪的话，下面「点歌格式」那两行会**盖在**这句话上（实测叠字）。
            sy += 58
        # 只显示接下来的 3 首，而且**不带歌手** ——
        # 观众只关心「下一首是不是我点的」，歌手名把一行撑满反而看不清歌名。
        for i, song in enumerate(songs[:3]):
            if isinstance(song, (list, tuple)):  # 桥传过来是 JSON 数组，本地 demo 是元组
                title = str(song[0]) if song else ""
            else:
                title = str(song)
            title = fit_text(title, SW - 76 - 40 - 20, 29, bold=(i == 0))
            hot = i == 0
            T(px, sy + 4, str(i + 1), 24, PRI if hot else FAINT)
            T(px + 40, sy, title, 29, PRI if hot else INK, bold=hot)
            # 第一首用 teal 标出来是「下一首」，但不画音柱 ——
            # 音柱是「正在放」的符号，上面「正在播放」那块已经有了，
            # 这里再画一根，观众会以为列表第一首就是当前歌。
            sy += 58

        # ---- 点歌规范（2026-10-27 主人要求「页面上也做一个提示」）----
        # 卡片高度已经把这一行算进去了（c2h 里的 +TIP_H）。
        # 文字从桥的 /state.json 拿（songTip），桥那边又从 reply.mjs 的 SONG_TIP 拿 ——
        # 改格式只改一处，屏幕跟着变，不会出现「屏上写 A、她嘴上说 B」。
        tip = str(st.get("songTip") or "点歌，歌名，歌手（可不填）")
        # 2026-10-27 晚：主人截图反馈「太小太暗了，不好看清楚」。
        # 20/FAINT(白 44% 透明) 在两米外看直播基本是糊的 —— 观众真要照着打字，
        # 这一行就是唯一的说明书。抬到 22/28，颜色提到 DIM / INK。
        T(px, sy + 8, "点歌格式", 22, DIM)
        T(px, sy + 38, fit_text(tip, SW - 60, 28), 28, INK)

    # ---- 顶部标语（2026-10-27 晚主人指定位置）----
    # 「刷礼物有惊喜」原来在右栏待机时当小字（24 号）用，藏在显示器上方，观众看不见。
    # 现在挪到画面最上方、角色头顶正上方那条空带里 —— 那里本来就什么都没有，
    # 左右两张卡（本场数据 x≤516、显示器 x≥1262）都离得远，放一行大字不打架。
    # ★ 2026-10-28：位置改由 layout.json 决定（编辑器里能拖）。
    #   框是 (BANNER_X, BANNER_Y, BANNER_W)，文字按 BANNER_ALIGN 在框内对齐。
    #   默认值就是原来那套：700/26/520 + 居中 —— 拖之前和以前一模一样。
    if VIS.get("banner", True):
        if BANNER_ALIGN == "left":
            T(BANNER_X, BANNER_Y, "刷礼物有惊喜", BANNER_SIZE, PRI, bold=True, anchor="la")
        elif BANNER_ALIGN == "right":
            T(BANNER_X + BANNER_W, BANNER_Y, "刷礼物有惊喜", BANNER_SIZE, PRI,
              bold=True, anchor="ra")
        else:
            T(BANNER_X + BANNER_W // 2, BANNER_Y, "刷礼物有惊喜", BANNER_SIZE, PRI,
              bold=True, anchor="ma")

    # ---- 皮套脚下的影子 ----
    # 人物本身每帧都要换（会呼吸），所以它挪到 compose() 里画了；
    # 影子不动，留在这层，省一次逐帧合成。
    # 影子跟着皮套走（2026-10-28）：以前是写死「水平居中、距底 44」，皮套能拖之后
    # 就必须跟着，否则人挪走了地上还剩一坨影子。
    if VIS.get("character", True):
        sh_w, sh_h = int(CHAR_W * 0.70) * SS, 54 * SS
        img.alpha_composite(
            ground_shadow(sh_w, sh_h),
            (int(CHAR_X + (CHAR_W - sh_w / SS) / 2) * SS,
             (CHAR_Y + CHAR_H - 44) * SS),
        )

    img.alpha_composite(lay)
    return img.convert("RGB").resize((W, H), Image.BOX)


def base(st):
    global _BASE, _BASE_KEY
    # 先让模块级常量跟上 layout.json（内部 0.5 秒限流，逐帧调用也不疼）。
    # 🔴 必须在 base_key() 之前：base_key 里的 _LAYOUT_STAMP 是 layout() 更新的。
    apply_layout()
    k = base_key(st)
    if _BASE is None or _BASE_KEY != k:
        t0 = time.perf_counter()
        _BASE = build_base(st)
        _BASE_KEY = k
        if os.environ.get("ZY_DEBUG"):
            print(f"[base] 重建 {(time.perf_counter()-t0)*1000:.0f}ms", file=sys.stderr)
    return _BASE


# ---------------------------------------------------------------- 逐帧合成
_T0 = time.time()  # 老桥不发 moodAt 时的兜底时钟


def _char_now(st):
    """当前该播哪一段、播到第几秒。

    桥只说两件事：「什么心情」和「这个心情从哪一刻开始」（moodAt，epoch 毫秒）。
    相位在这儿算 —— 画面 0.4 秒才轮询一次状态，要是让相位跟着轮询走，
    动作就会一顿一顿的。用绝对时间算，掉帧了也能追上。

    ⚠️ 老版本桥（没 moodAt）不能让它退化成 0 —— 那样永远播第 1 帧，
       看着就是"卡住不动"，比不动还难受。所以没有 moodAt 就用本地时钟。
    """
    mood = st.get("mood") or ("talk" if st.get("subtitle") else "idle")
    clip = pet.clip_for(mood)
    try:
        t = max(0.0, (time.time() * 1000 - float(st.get("moodAt"))) / 1000.0)
    except (TypeError, ValueError):
        t = time.time() - _T0
    dur = pet.duration(clip)
    # 高兴/委屈这种只播一遍：播完回待机，不然她会一直笑下去
    if clip != "idle" and dur and t > dur:
        clip, t = "idle", t - dur
    return clip, t


def draw_character(img, st):
    """把皮套贴上去。没有动作素材就退回静态图，画面不会开天窗。"""
    if not pet.available():
        _static_character(img)
        return
    try:
        clip, t = _char_now(st)
        fr = pet.frame(clip, t, CHAR_W)
        if fr is None:
            _static_character(img)
            return
        x, y, _ = pet.place(CHAR_W, W, CHAR_Y + CHAR_H, cx=CHAR_X + CHAR_W / 2.0)
        blit(img, fr, x, y)
    except Exception as e:
        # 直播里最怕的就是"人突然没了"。动作帧出任何问题都退回静态立绘，
        # 顶多是不动，不能是空白。
        print(f"[char] 动作帧出错，退回静态图：{type(e).__name__}: {e}", file=sys.stderr)
        _static_character(img)


def _static_character(img):
    ch = character(CHAR_W)
    # 底边对齐到 CHAR_Y+CHAR_H（= 皮套框的下沿），这样拖框时脚不会离地
    img.alpha_composite(
        ch, (CHAR_X * SS, (CHAR_Y + CHAR_H - int(ch.height / SS)) * SS)
    )


def _round_mask(w, h, r):
    """圆角遮罩（L 模式），贴屏幕画面用 —— 不带遮罩贴上去四角是死的。"""
    key = ("mask", w, h, r)
    p = _PATCH.get(key)
    if p is None:
        m = Image.new("L", (w, h), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
        if len(_PATCH) > 400:
            _PATCH.clear()
        _PATCH[key] = p = m
    return p


def draw_danmaku(img, st, d, f):
    """原来的右侧弹幕列。默认不画了（ZY_DANMAKU=1 才走这里）。"""
    dm = (st.get("danmaku") or [])[-7:]
    gap, pad_x, pad_y, line_h = 14, 22, 16, 42
    if dm:
        bh = pad_y * 2 + line_h
        layout = []
        for m in dm:
            u, t = str(m.get("user", "")), str(m.get("text", ""))
            # 气泡最宽 DM_MAXW。昵称和正文各自按像素截断加省略号，先截昵称 ——
            # 昵称太长的话正文会被挤成两三个字，那比截昵称更难看。
            u = fit_text(u, DM_NAMEW, 24)
            uw = d.textlength(u, font=f(24))
            t = fit_text(t, DM_MAXW - pad_x * 2 - uw - 14, 28)
            tw = uw + d.textlength(t, font=f(28)) + 14
            layout.append((u, t, min(DM_MAXW, int(tw + pad_x * 2 + 2) // 4 * 4)))
        y = DM_BOTTOM - len(dm) * bh - gap * (len(dm) - 1)
        for (u, t, bw), m in zip(layout, dm):
            kind = m.get("kind") or ""
            if kind == "gift":
                fill, ucol = (79, 55, 139, 255), TER
            elif kind == "me":
                fill, ucol = (99, 59, 72, 255), (255, 216, 228, 255)
            else:
                fill, ucol = (43, 41, 48, 255), (204, 194, 220, 255)
            x0 = DM_RIGHT - bw
            sh, pad = shadow_patch(bw, bh, 20)
            blit(img, sh, x0 - pad, y - pad + 2)
            blit(img, rr_patch(bw, bh, 20, fill), x0, y)
            d.text((x0 + pad_x, y + pad_y + 1), u, font=f(24), fill=ucol)
            d.text((x0 + pad_x + d.textlength(u, font=f(24)) + 14, y + pad_y), t,
                   font=f(28), fill=INK)
            y += bh + gap
    else:
        d.text((DM_RIGHT, DM_BOTTOM - 30), "还没有人说话…",
               font=f(24), fill=(255, 255, 255, 46), anchor="ra")


def _screen_idle(d, f, st, med):
    """空闲画面：待机壁纸（网格 + 时钟）。不自动循环播素材，安安静静待着。

    🔴 亮度（2026-10-27 主人：「待机的时候不要这么暗，正常亮度就行」）：
       原来底色 (15,19,25)、时钟 alpha 58、网格 alpha 11 —— 整体像关了机。
       现在按「一块亮着的屏幕」调：底色 (34,40,52)、时钟 210、网格 26。
       别怕亮：右侧那台电脑是画面里唯一会动的东西，太暗观众以为卡了。

    🔴 小字全部去掉（同一句要求）：原来底部还有一行「media 目录里还没有素材」，
       屏幕上只留「时钟 + 待机中」两样东西，干净。
    """
    if str(med.get("idle") or "standby") == "black":
        # 纯黑：屏幕像关了机。只在中间留一个几乎看不见的小点，免得观众以为画面挂了。
        d.rectangle((SCR_X, SCR_Y, SCR_X + SCR_W, SCR_Y + SCR_H), fill=(8, 7, 10, 255))
        d.ellipse((SCR_X + SCR_W // 2 - 2, SCR_Y + SCR_H // 2 - 2,
                   SCR_X + SCR_W // 2 + 2, SCR_Y + SCR_H // 2 + 2),
                  fill=(255, 255, 255, 16))
        return

    # 底色别跟页面背景 (7,9,12) 一样 —— 一样就只剩一圈框，看不出「屏亮着」。
    d.rectangle((SCR_X, SCR_Y, SCR_X + SCR_W, SCR_Y + SCR_H), fill=(33, 29, 44, 255))
    # 细网格 —— 有「屏幕亮着」的感觉，又不会抢戏
    for gx in range(SCR_X + 18, SCR_X + SCR_W, 26):
        d.line((gx, SCR_Y, gx, SCR_Y + SCR_H), fill=(255, 255, 255, 26))
    for gy in range(SCR_Y + 18, SCR_Y + SCR_H, 26):
        d.line((SCR_X, gy, SCR_X + SCR_W, gy), fill=(255, 255, 255, 26))

    if not med.get("on", True):
        d.text((SCR_X + SCR_W // 2, SCR_Y + SCR_H // 2 - 12), "媒体播放已关",
               font=f(34, True), fill=(255, 255, 255, 150), anchor="mm")
        d.text((SCR_X + SCR_W // 2, SCR_Y + SCR_H // 2 + 34), "礼物只发感谢，不播素材",
               font=f(22), fill=(255, 255, 255, 96), anchor="mm")
        return

    hhmm = time.strftime("%H:%M")
    d.text((SCR_X + SCR_W // 2, SCR_Y + SCR_H // 2 - 18), hhmm,
           font=f(70, True), fill=(255, 255, 255, 210), anchor="mm")
    d.text((SCR_X + SCR_W // 2, SCR_Y + SCR_H // 2 + 46), "待机中",
           font=f(24), fill=(255, 255, 255, 130), anchor="mm")


def _screen_audio(d, f, st, cur, tsec):
    """音频档：屏幕画一排跟着时间跳的竖条。没有真频谱，够看就行。"""
    import math

    d.rectangle((SCR_X, SCR_Y, SCR_X + SCR_W, SCR_Y + SCR_H), fill=(10, 14, 18, 255))
    n = 22
    bw = 8
    gap = (SCR_W - 60 - n * bw) / max(1, n - 1)
    base_y = SCR_Y + SCR_H - 54
    for i in range(n):
        a = tsec * 3.4 + i * 0.62
        v = 0.42 + 0.34 * math.sin(a) + 0.18 * math.sin(a * 2.3 + 1.1)
        v = max(0.12, min(1.0, v))
        hgt = int(v * 92)
        x = SCR_X + 30 + i * (bw + gap)
        # 🔴 别写 `or 1`：闲时档就是 0，or 会把它变成礼物 1 档的颜色
        _t = cur.get("tier")
        col = TIER_COL.get(0 if _t is None else int(_t), PRI)
        d.rounded_rectangle((x, base_y - hgt, x + bw, base_y), radius=4,
                            fill=(col[0], col[1], col[2], 210))
    # ⚠️ 别用 ♪ / ♫ —— 思源黑体里没有，会渲染成豆腐块（这个坑 2026-10-26 踩过）
    d.text((SCR_X + SCR_W // 2, SCR_Y + 34), "音频播放中",
           font=f(24, True), fill=(255, 255, 255, 120), anchor="mm")
    nm = os.path.splitext(str(cur.get("name") or ""))[0]
    d.text((SCR_X + SCR_W // 2, base_y + 22), fit_text(nm, SCR_W - 60, 20),
           font=f(20), fill=(255, 255, 255, 90), anchor="mm")


# 逐帧图层（半透明元件专用）。全尺寸 RGBA 每帧新建要 8MB 的分配，15fps 下太浪费；
# 复用一块、每帧只清右栏那一小块。
#
# 🔴 上边界是 CAP_Y - 16，不是 CARD_Y（2026-10-27 改）：
#    原来右栏上方还有一张「礼物媒体」队列卡（顶在 CARD_Y=236），所以图层得从那儿开始清。
#    主人说那张卡不要了，右栏现在**只剩显示器**，最高的东西就是 CAP_Y 那行
#    「正在播放 / 电脑待机中 - 刷礼物有惊喜」（字顶约 CAP_Y-6，档位徽标顶 CAP_Y-4）。
#    再往上留 10px 余量就够 —— 从 CARD_Y 开始清纯属白清 160px 高的透明区。
_LAY = None
_LAY_BOX = (MON_X - 24, CAP_Y - 16, min(W, MON_X + MON_W + 24), FOOT_Y + 44)


def _lay():
    global _LAY
    if _LAY is None:
        _LAY = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    else:
        _LAY.paste((0, 0, 0, 0), _LAY_BOX)
    return _LAY


def draw_computer(img, st, d, f):
    """礼物档位「电脑」展示区。

    st 里跟它有关的三样：
      st['media']        桥给的 {on, cur:{seq,name,kind,tier,user,gift,maxMs,at}, counts, queue}
      st['_media_frame'] 解码好的一帧（PIL RGB，尺寸 = SCR_W×SCR_H），没有就 None
      st['_media_error'] 打不开时的可读原因（有就在屏幕上直说）

    🔴 半透明的东西必须画在 RGBA 图层上再合成（2026-10-27 修）：
       img 是 RGB，ImageDraw 遇到 fill=(255,255,255,70) 这种四元组会**丢掉 alpha**，
       直接画成纯白。原来「待机中 · 等礼物」「媒体播放已关」全白得刺眼，就是这原因。
       左边那两张卡没事，因为它们本来就画在独立的 RGBA 层上（见 build_base）。
    """
    med = st.get("media") or {}
    cur = med.get("cur") or None
    frame = st.get("_media_frame")
    err = str(st.get("_media_error") or "")
    tier = int((cur or {}).get("tier") or 0)
    col = TIER_COL.get(tier, PRI)
    tsec = (time.time() - (cur.get("at") or 0) / 1000.0) if cur else 0.0

    lay = _lay()
    d = ImageDraw.Draw(lay)  # 从这里开始，d 画的是带 alpha 的那一层

    # ---- 底座 + 脖子（漫画风：扁平色块 + 极淡描边，不做渐变）----
    # 🔴 2026-10-27 晚改：原来脖子 (26,30,36)、底座 (30,34,41)，而背景是 (21,26,33) ——
    #    只差 5~9 个色阶，远看就是「一块悬空的屏幕」。主人原话：「不像电脑，
    #    是不是下面的支架显得颜色不显眼」。对，就是支架看不见。
    #    改法：支架整体抬到 50~90 区间（跟屏幕壳的 23,27,33 明确分开），
    #    两侧一明一暗、底座两层，靠明暗差把「这是一台立着的显示器」讲清楚。
    cx = MON_X + MON_W // 2
    # 2026-10-28：显示器宽度现在能拖（layout.json 的 w），支架整套跟着等比缩，
    # 不然拉宽之后脖子还是 44px 宽，像根牙签插在屏幕底下。
    # k=1.0 时下面每个 S() 都还原成原来的整数，出图和以前一模一样。
    k = MON_K
    S = lambda v: max(1, int(round(v * k)))          # noqa: E731
    sh, pad = shadow_patch(S(250), S(26), S(12), blur=max(4, S(16)), alpha=145)
    blit(img, sh, cx - S(125) - pad, FOOT_Y + S(4) - pad)
    # 脖子：真显示器是「挂板 + 细柱 + 底部外扩」，不是一块倒三角。
    # 第一版画成上宽下窄（88→60），放大看像冰淇淋甜筒，反而更怪 —— 改成下宽上窄。
    d.polygon([(cx - S(22), NECK_Y + S(4)), (cx + S(22), NECK_Y + S(4)),
               (cx + S(28), FOOT_Y + S(3)), (cx - S(28), FOOT_Y + S(3))],
              fill=(70, 64, 86, 255))
    # 一道竖向高光偏右 = 圆柱被左上方来的光打亮，平面色块立刻有体积
    d.line([(cx + S(9), NECK_Y + S(5)), (cx + S(12), FOOT_Y + S(2))],
           fill=(255, 255, 255, 22), width=max(1, S(3)))
    d.line([(cx + S(22), NECK_Y + S(4)), (cx + S(28), FOOT_Y + S(3))],
           fill=(255, 255, 255, 58), width=max(1, S(2)))
    d.line([(cx - S(22), NECK_Y + S(4)), (cx - S(28), FOOT_Y + S(3))],
           fill=(0, 0, 0, 130), width=max(1, S(2)))
    # 挂板：贴在屏幕下沿的一块窄条，把「屏幕」和「脖子」接起来。
    # 不画它，柱子直接从屏幕上长出来，接缝那道黑线会像个「倒 T 字」。
    blit(img, rr_patch(S(92), S(8), S(3), (64, 58, 78, 255), outline=(255, 255, 255, 40)),
         cx - S(46), NECK_Y - 1)
    # 底座：下盘（宽）+ 上盘（窄、更亮）= 有厚度的感觉
    blit(img, rr_patch(S(238), S(17), S(8), (88, 82, 104, 255), outline=(255, 255, 255, 56)),
         cx - S(119), FOOT_Y + 1)
    blit(img, rr_patch(S(196), S(8), S(4), (116, 110, 136, 255)),
         cx - S(98), FOOT_Y + 1)

    # ---- 显示器外壳 ----
    # 边框比背景只亮一点点（23,27,33 vs 21,26,33），所以轮廓线得靠得住：
    # 原来 255/38 太淡，屏幕像是直接浮在背景上。抬到 62，并在顶边压一道高光。
    blit(img, rr_patch(MON_W, MON_H, S(20), (48, 43, 60, 255),
                       outline=(255, 255, 255, 62), width=1), MON_X, MON_Y)
    d.line([(MON_X + S(20), MON_Y + 1), (MON_X + MON_W - S(20), MON_Y + 1)],
           fill=(255, 255, 255, 26), width=1)
    # 屏幕四周的一圈内沿，让「屏」和「框」分得开
    blit(img, rr_patch(SCR_W + S(8), SCR_H + S(8), S(12), (10, 9, 13, 255)),
         SCR_X - S(4), SCR_Y - S(4))

    # ---- 屏幕内容 ----
    if err:
        d.rectangle((SCR_X, SCR_Y, SCR_X + SCR_W, SCR_Y + SCR_H), fill=(30, 14, 20, 255))
        d.text((SCR_X + SCR_W // 2, SCR_Y + SCR_H // 2 - 18), "素材放不出来",
               font=f(30, True), fill=(255, 150, 140, 235), anchor="mm")
        d.text((SCR_X + SCR_W // 2, SCR_Y + SCR_H // 2 + 22),
               fit_text(err, SCR_W - 50, 19), font=f(19),
               fill=(255, 255, 255, 120), anchor="mm")
    elif not cur:
        _screen_idle(d, f, st, med)
    elif (cur.get("kind") or "") == "audio" and not frame:
        _screen_audio(d, f, st, cur, tsec)
    elif frame is not None:
        # 尺寸不对就现缩 —— 解码那边已经保证是 SCR_W×SCR_H，这道只是保险。
        # 直播里宁可慢 3ms，也不能因为一张图尺寸不对把整帧 compose 抛崩（= 黑屏）。
        if frame.size != (SCR_W, SCR_H):
            frame = frame.convert("RGB").resize((SCR_W, SCR_H), Image.LANCZOS)
        img.paste(frame, (SCR_X, SCR_Y), _round_mask(SCR_W, SCR_H, 8))
    else:
        # 还没解出第一帧（视频起 ffmpeg 的那一下），先给个「加载中」
        d.rectangle((SCR_X, SCR_Y, SCR_X + SCR_W, SCR_Y + SCR_H), fill=(10, 12, 16, 255))
        d.text((SCR_X + SCR_W // 2, SCR_Y + SCR_H // 2), "正在打开素材…",
               font=f(22), fill=(255, 255, 255, 70), anchor="mm")

    # ---- 播放进度：屏幕底边一条细线 ----
    if cur and not err:
        max_ms = max(1, int(cur.get("maxMs") or 1))
        el = max(0, min(max_ms, int(time.time() * 1000 - (cur.get("at") or 0))))
        wpx = int(SCR_W * el / max_ms)
        if wpx > 0:
            d.rectangle((SCR_X, SCR_Y + SCR_H - 3, SCR_X + wpx, SCR_Y + SCR_H),
                        fill=(col[0], col[1], col[2], 200))

    # ---- 摄像头小圆点 + 指示灯（纯粹的「这是一台电脑」暗示）----
    d.ellipse((cx - 3, MON_Y + 7, cx + 3, MON_Y + 13), fill=(255, 255, 255, 34))
    led = (70, 224, 192, 255) if (cur and not err) else (255, 255, 255, 40)
    d.ellipse((MON_X + 14, MON_Y + MON_H - 11, MON_X + 20, MON_Y + MON_H - 5), fill=led)

    # ---- 上方说明：正在放什么 / 谁送的 / 哪个礼物 ----
    if cur and not err:
        d.text((MON_X, CAP_Y), "正在播放", font=f(20), fill=DIM)
        # 档位徽标（0 档是闲时素材，不叫「档位0」）
        # 0 档还分两种：场子冷了自动放的「闲时」/ 观众喊「放个视频」的「点播」。
        # 只写「闲时」的话，点播那次的画面看着像是自己冒出来的，第二行的观众昵称
        # 也就变成了没头没尾的一个名字。
        if tier == 0:
            # `user` 兜底是为了「桥还没重启」的情况：闲时那一路从来不填 user，
            # 所以只要第二行有名字，就一定有人点播过。这样这次改动不用为一行
            # 徽标去重启正在直播的桥。
            badge = "点播" if (cur.get("request") or cur.get("user")) else "闲时"
        else:
            badge = f"档位{tier}"
        bw2 = int(d.textlength(badge, font=f(19, True))) + 20
        # 徽标：底色只留一点档位 hue，**字用亮的 INK**。
        # 原来字也用档位色，配青/金那种高饱和色还挺清楚；换成浅紫之后
        # 字和底几乎同色，「档位1」糊成一团（截图里实测）。
        blit(img, rr_patch(bw2, 28, 8, (col[0], col[1], col[2], 46),
                           outline=(col[0], col[1], col[2], 140)), MON_X + 96, CAP_Y - 4)
        d.text((MON_X + 96 + bw2 // 2, CAP_Y + 10), badge, font=f(19, True),
               fill=INK, anchor="mm")
        nm = os.path.splitext(str(cur.get("name") or ""))[0]
        d.text((MON_X + 96 + bw2 + 12, CAP_Y), fit_text(nm, MON_W - 96 - bw2 - 12, 20),
               font=f(20), fill=INK)
        who = " · ".join(x for x in [str(cur.get("user") or ""), str(cur.get("gift") or "")]
                         if x)
        if who:
            d.text((MON_X, CAP_Y + 34), fit_text(who, MON_W, 22), font=f(22), fill=DIM)
    elif err:
        d.text((MON_X, CAP_Y + 10), "素材有问题（不影响直播和感谢）",
               font=f(21), fill=(255, 150, 140, 220))
    else:
        # 待机时右栏**什么都不写**（2026-10-27 晚主人要求：「这个就不用显示了」）。
        # 原来这里是「电脑待机中 - 刷礼物有惊喜」一行 24 号字。
        # 那句话已经挪到画面最上方的空带里做成频道标语，右栏留着只是一块黑屏，
        # 空着反而干净 —— 显示器本来就是「待机中」的状态，不用再解释一遍。
        pass

    # ---- 把这一层半透明的东西合回去（只处理右栏那一小块，别整图过一遍）----
    box = _LAY_BOX
    region = lay.crop(box)
    img.paste(region, (box[0], box[1]), region)


def compose(st):
    """st 见 overlay.py；返回 1920×1080 RGB"""
    img = base(st).copy()          # base() 里已经 apply_layout()，常量是最新的
    if VIS.get("character", True):
        draw_character(img, st)
    d = ImageDraw.Draw(img)
    f = lambda s, b=False: font(s, b, ss=False)

    # ---- 本场数据（数字会变） ----
    if VIS.get("stats", True):
        ry = CARD_Y + 30 + 60
        for val, col in (
            (st.get("chat", 0), PRI),
            (st.get("gift", 0), TER),
            (st.get("replied", 0), INK),
        ):
            d.text((CARD_X + CARD_W - 30, ry), str(val), font=f(27), fill=col, anchor="ra")
            ry += 46

    # ---- 右下角实时信息 ----
    sec = int(st.get("sec", 0) or 0)
    mm, ss_ = sec // 60, sec % 60
    d.text((W - 64, H - 96), f"在线 {st.get('online', 0)} · 本场 {mm:02d}:{ss_:02d}",
           font=f(22), fill=FAINT, anchor="ra")
    d.text((W - 64, H - 60), f"饭钱 {float(st.get('money', st.get('token', 0)) or 0):.2f}",
           font=f(22), fill=TER if float(st.get('money', st.get('token', 0)) or 0) <= 1 else FAINT,
           anchor="ra")

    # ---- 右侧：礼物档位「电脑」展示区（2026-10-27 换掉原来的弹幕列） ----
    # 原来这里是自底向上的弹幕气泡。主人要求「移除用户评论区，换成电脑展示区」，
    # 所以默认走电脑；想看回弹幕就设环境变量 ZY_DANMAKU=1（代码没删，只是不画）。
    # 2026-10-28：右栏「显示器 / 弹幕列」现在是二选一 —— 编辑器里点亮哪个就画哪个
    # （两个都占着右栏，同时画只会叠在一起，没有意义）。
    show_dm = DANMAKU_ON or VIS.get("danmaku", False)
    if VIS.get("monitor", True) and not show_dm:
        draw_computer(img, st, d, f)
    if show_dm:
        draw_danmaku(img, st, d, f)

    # ---- 底部字幕 ----
    sub = st.get("subtitle")
    if sub and VIS.get("subtitle", True):
        tag, fs_ = "说话", f(21)
        tw = d.textlength(tag, font=fs_)
        body_w = d.textlength(str(sub), font=f(34))
        # 按内容收窄：定宽 900 时短句右边会空一大片，看着像没画完。
        # 上限仍是 SUB_W（34px 字号下约 21 个汉字，超了本来就该截断），下限 520 免得短句挤成一条。
        bw2 = int(max(520, min(SUB_W, 30 + tw + 46 + body_w + 30))) // 4 * 4
        # 2026-10-28：字幕条位置由 layout.json 决定，收窄后仍然在框内居中
        sx = SUB_X + (SUB_W - bw2) // 2
        sy2 = SUB_Y
        # 纯色版不再垫投影（2026-10-27 晚）：卡片和字幕条都是实色，
        # 底部再加一圈柔边只会让边缘发虚，M3E 的平面语言里也没有投影这一层。
        blit(img, rr_patch(bw2, SUB_H, 24, CARD), sx, sy2)
        blit(img, rr_patch(int(tw) + 28, 34, 9, PRI), sx + 30, sy2 + 26)
        d.text((sx + 44, sy2 + 32), tag, font=fs_, fill=ON_PRI)
        d.text((sx + 30 + tw + 46, sy2 + 22), str(sub), font=f(34), fill=INK)

    return img


def demo_state():
    return {
        "name": "zuige大肥鱼",
        "state": "idle",
        "stateText": "直播中",
        "mood": "idle",
        "moodAt": time.time() * 1000,
        "online": 20,
        "sec": 754,
        "chat": 79,
        "gift": 23,
        "replied": 12,
        "token": 81.31,
        "songs": ["晴天", "海阔天空", "鱼仔"],
        "queue": {"total": 12, "why": ""},
        "music": {"title": "I Really Like You", "artist": "Carly Rae Jepsen", "playing": True},
        "danmaku": [
            {"user": "阿伟", "text": "这歌真的好听", "kind": ""},
            {"user": "momo", "text": "主播今天状态不错啊", "kind": ""},
            {"user": "夜色", "text": "送出「小心心」", "kind": "gift"},
            {"user": "小蒋", "text": "这是 AI 吗 好像真人", "kind": ""},
            {"user": "zuige大肥鱼", "text": "谢谢阿伟的小心心~", "kind": "me"},
        ],
        "subtitle": "刚刷到一条修键盘的，居然把轴拆开一个个洗",
    }


def main():
    args = sys.argv[1:]

    def opt(name, default=None):
        if name not in args:
            return default
        i = args.index(name)
        return args[i + 1] if i + 1 < len(args) else default

    # 看某一帧：--clip happy --t 2.4
    clip, at = opt("--clip"), opt("--t")

    # 导出默认版式（含每个组件的自适应高度），给 editor.html 当初始档：
    #   python render.py --dump-layout > cache/layout.json
    if "--dump-layout" in args:
        L = _layout_default()
        for _k, _c in L["items"].items():
            _c["h"] = comp_h(_k, _c["x"], _c["y"], _c["w"])
        print(json.dumps(L, ensure_ascii=False, indent=2))
        return

    if "--bench" in args:
        st = demo_state()
        compose(st)  # 预热（字体、静态层、第一帧动作）
        n = int(opt("--n", 120))
        # 真实播放时每一帧动作都在变，所以相位必须跟着走。
        # 拿同一帧跑 30 次只会命中缓存，量出来 5ms 是假的。
        t0, w0 = time.process_time(), time.time()
        for i in range(n):
            st["moodAt"] = time.time() * 1000 - (i / pet.FPS) * 1000
            compose(st)
        cpu = (time.process_time() - t0) / n * 1000
        print(f"逐帧合成 {cpu:.1f} ms/帧（{n} 帧，含动作帧解码）")
        print(f"按 {pet.FPS:g}fps 播 ⇒ 单核 {cpu * pet.FPS / 10:.0f}% CPU"
              f"（{n} 帧实际用了 {time.time()-w0:.1f}s，不含 BitBlt）")
        t0 = time.perf_counter()
        build_base(st)
        print(f"静态层重建 {(time.perf_counter()-t0)*1000:.0f} ms（只在点歌列表变化时发生）")
    out = None
    if "--shot" in args:
        out = opt("--shot", "shot.png")
    if out:
        st = demo_state()
        if clip:
            st["mood"] = clip
            st["moodAt"] = time.time() * 1000 - float(at or 0) * 1000
        t0 = time.perf_counter()
        img = compose(st)
        img.save(out)
        print(f"{out}  {img.size}  耗时 {(time.perf_counter()-t0)*1000:.0f}ms")


# 导入时先把版式装上（不只是 __main__ 跑的时候）：
# overlay.py 会直接读 render.SCR_W / render.SCR_H 去初始化解码器，
# 等到第一帧 compose() 里才 apply_layout 就晚了一步，解码尺寸会对不上。
try:
    apply_layout()
except Exception as _e:                      # 版式坏了也不能连画面都起不来
    print(f"[layout] 初始化失败（{type(_e).__name__}: {_e}），用默认版式", file=sys.stderr)
    VIS = {}


if __name__ == "__main__":
    main()
