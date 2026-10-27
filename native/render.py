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
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import pet  # 动作帧播放器（native/pet.py）；没有素材时它自己会说不可用

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

W, H = 1920, 1080
SS = 2  # 静态层超采样倍数：先按 2 倍画再缩回去，圆角和图才不毛糙

INK = (246, 249, 252, 255)
DIM = (180, 191, 204, 255)
TEAL = (70, 224, 192, 255)
GOLD = (242, 193, 78, 255)
PINK = (255, 123, 169, 255)
BG = (21, 26, 33, 255)
FAINT = (255, 255, 255, 112)
HAIR = (255, 255, 255, 36)

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

TIER_COL = {
    # 0 档是「闲时素材」，不是礼物 —— 用中性青灰，别和礼物档抢颜色。
    0: (150, 170, 186, 255),  # 闲时 · 青灰
    1: (70, 224, 192, 255),   # 小额 · 青
    2: (255, 123, 169, 255),  # 中额 · 粉
    3: (242, 193, 78, 255),   # 大额 · 金
    4: (255, 138, 76, 255),   # 特效 · 橙
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


def background():
    global _BG
    if _BG is None:
        img = Image.new("RGBA", (W * SS, H * SS), BG)
        # 两层柔光让画面有纵深。跟着整体提亮一起抬高（26→42 / 22→34），
        # 不然底色一亮，光晕就看不出来了，画面会变成一块平板。
        img.alpha_composite(_glow((1500 * SS, 900 * SS), (70, 224, 192, 42)), (60 * SS, -120 * SS))
        img.alpha_composite(_glow((1300 * SS, 800 * SS), (255, 123, 169, 34)), (1180 * SS, 520 * SS))
        _BG = img
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
    return (
        # name 不再参与静态层：主播牌已经删了（2026-10-27 晚），
        # 还留着这一项只会让「改昵称」白重建一次静态层。
        songs_key,
        int(((st.get("queue") or {}).get("total")) or 0),
        mus.get("title") or "",
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

    # ---- 左上：本场数据（原来上面还有一张主播牌，2026-10-27 晚按主人要求删掉）----
    rows = [("收到弹幕", GOLD), ("收到礼物", None), ("已回复", GOLD)]
    c1h = 32 + 36 + len(rows) * 46 + 10
    ld.rounded_rectangle(
        (CARD_X * SS, CARD_Y * SS, (CARD_X + CARD_W) * SS, (CARD_Y + c1h) * SS),
        radius=24 * SS, fill=(31, 38, 47, 224), outline=HAIR, width=SS,
    )
    px, py = CARD_X + 30, CARD_Y + 30
    T(px, py, "本场数据", 25, DIM)
    T(CARD_X + CARD_W - 30, py, "实时", 22, FAINT, anchor="ra")
    ry = py + 60
    for label, _ in rows:
        T(px, ry, label, 27, DIM)
        ry += 46

    songs = st.get("songs") or []
    # 正在播的歌（本机 QQ 音乐，桥通过 SMTC 读出来的）。没有就不占位置。
    mus = st.get("music") or None
    np_title = fit_text((mus or {}).get("title"), CARD_W - 76, 28, bold=True)
    np_by = fit_text((mus or {}).get("artist"), CARD_W - 76, 21)
    np_playing = bool((mus or {}).get("playing"))
    np_h = (114 if np_by else 88) if np_title else 0

    c2y = CARD_Y + c1h + 24
    # +62 是底部那两行「点歌格式 / 点歌，歌名，歌手（可不填）」，见下面 draw 部分。
    # 最后那个 +32 是底部留白 —— 原来 +18 时提示行的字几乎贴着卡片下边缘（实测只剩 5px）。
    c2h = 32 + 36 + np_h + max(len(songs), 1) * 58 + 62 + 32
    ld.rounded_rectangle(
        (CARD_X * SS, c2y * SS, (CARD_X + CARD_W) * SS, (c2y + c2h) * SS),
        radius=24 * SS, fill=(31, 38, 47, 224), outline=HAIR, width=SS,
    )
    T(px, c2y + 30, "点歌台", 25, DIM)
    q_total = int(((st.get("queue") or {}).get("total")) or 0)
    if q_total > 1:
        T(CARD_X + CARD_W - 30, c2y + 30, f"歌单 {q_total} 首", 22, FAINT, anchor="ra")
    sy = c2y + 88

    if np_title:
        # 「正在播放」一条。音柱只在真在放的时候亮，暂停时压成一条灰线，
        # 不然观众会以为卡住了。
        # ⚠️ 别用 ♪ / ♫ 这类符号：思源黑体里没有，会渲染成豆腐块（实测过）。
        #    小圆点自己画，一定不会缺字。
        ld.ellipse(((px + 3) * SS, (sy + 9) * SS, (px + 13) * SS, (sy + 19) * SS), fill=TEAL)
        T(px + 24, sy + 2, "正在播放", 21, FAINT)
        for j, hh in enumerate((10, 18, 13, 20) if np_playing else (5, 5, 5, 5)):
            bx = CARD_X + CARD_W - 30 - (4 - j) * 9
            ld.rounded_rectangle(
                (bx * SS, (sy + 24 - hh) * SS, (bx + 5) * SS, (sy + 24) * SS),
                radius=3 * SS, fill=TEAL if np_playing else FAINT,
            )
        T(px, sy + 30, np_title, 28, INK, bold=True)
        if np_by:
            T(px, sy + 68, np_by, 21, DIM)
        # 和下面的排队列表隔一条线，不然「艺人名」和「第 1 首」会粘在一起
        ld.rectangle(
            (px * SS, (sy + np_h - 16) * SS, (px + CARD_W - 60) * SS, (sy + np_h - 15) * SS),
            fill=(255, 255, 255, 20),
        )
        sy += np_h

    if not songs:
        T(px, sy + 6, "歌单还没读到", 26, FAINT)
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
        title = fit_text(title, CARD_W - 76 - 40 - 20, 29, bold=(i == 0))
        hot = i == 0
        T(px, sy + 4, str(i + 1), 24, TEAL if hot else FAINT)
        T(px + 40, sy, title, 29, TEAL if hot else INK, bold=hot)
        # 第一首用 teal 标出来是「下一首」，但不画音柱 ——
        # 音柱是「正在放」的符号，上面「正在播放」那块已经有了，
        # 这里再画一根，观众会以为列表第一首就是当前歌。
        sy += 58

    # ---- 点歌规范（2026-10-27 主人要求「页面上也做一个提示」）----
    # 卡片高度已经把这一行算进去了（c2h 里的 +TIP_H）。
    # 文字从桥的 /state.json 拿（songTip），桥那边又从 reply.mjs 的 SONG_TIP 拿 ——
    # 改格式只改一处，屏幕跟着变，不会出现「屏上写 A、她嘴上说 B」。
    tip = str(st.get("songTip") or "点歌，歌名，歌手（可不填）")
    T(px, sy + 6, "点歌格式", 20, FAINT)
    T(px, sy + 32, fit_text(tip, CARD_W - 60, 23), 23, DIM)

    # ---- 皮套脚下的影子 ----
    # 人物本身每帧都要换（会呼吸），所以它挪到 compose() 里画了；
    # 影子不动，留在这层，省一次逐帧合成。
    sh_w, sh_h = int(CHAR_W * 0.70) * SS, 54 * SS
    img.alpha_composite(
        ground_shadow(sh_w, sh_h),
        (int((W - sh_w / SS) / 2) * SS, (H - CHAR_BOTTOM - 44) * SS),
    )

    img.alpha_composite(lay)
    return img.convert("RGB").resize((W, H), Image.BOX)


def base(st):
    global _BASE, _BASE_KEY
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
        x, y, _ = pet.place(CHAR_W, W, H - CHAR_BOTTOM)
        blit(img, fr, x, y)
    except Exception as e:
        # 直播里最怕的就是"人突然没了"。动作帧出任何问题都退回静态立绘，
        # 顶多是不动，不能是空白。
        print(f"[char] 动作帧出错，退回静态图：{type(e).__name__}: {e}", file=sys.stderr)
        _static_character(img)


def _static_character(img):
    ch = character(CHAR_W)
    img.alpha_composite(
        ch, (((W - CHAR_W) // 2) * SS, (H - CHAR_BOTTOM - int(ch.height / SS)) * SS)
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
                fill, ucol = (52, 40, 12, 214), GOLD
            elif kind == "me":
                fill, ucol = (8, 42, 38, 214), TEAL
            else:
                fill, ucol = (11, 15, 20, 206), (112, 198, 184, 255)
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
        d.rectangle((SCR_X, SCR_Y, SCR_X + SCR_W, SCR_Y + SCR_H), fill=(4, 5, 7, 255))
        d.ellipse((SCR_X + SCR_W // 2 - 2, SCR_Y + SCR_H // 2 - 2,
                   SCR_X + SCR_W // 2 + 2, SCR_Y + SCR_H // 2 + 2),
                  fill=(255, 255, 255, 16))
        return

    # 底色别跟页面背景 (7,9,12) 一样 —— 一样就只剩一圈框，看不出「屏亮着」。
    d.rectangle((SCR_X, SCR_Y, SCR_X + SCR_W, SCR_Y + SCR_H), fill=(34, 40, 52, 255))
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
        col = TIER_COL.get(0 if _t is None else int(_t), TEAL)
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
    col = TIER_COL.get(tier, TEAL)
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
    sh, pad = shadow_patch(250, 26, 12, blur=16, alpha=145)
    blit(img, sh, cx - 125 - pad, FOOT_Y + 4 - pad)
    # 脖子：真显示器是「挂板 + 细柱 + 底部外扩」，不是一块倒三角。
    # 第一版画成上宽下窄（88→60），放大看像冰淇淋甜筒，反而更怪 —— 改成下宽上窄。
    d.polygon([(cx - 22, NECK_Y + 4), (cx + 22, NECK_Y + 4),
               (cx + 28, FOOT_Y + 3), (cx - 28, FOOT_Y + 3)],
              fill=(52, 59, 70, 255))
    # 一道竖向高光偏右 = 圆柱被左上方来的光打亮，平面色块立刻有体积
    d.line([(cx + 9, NECK_Y + 5), (cx + 12, FOOT_Y + 2)], fill=(255, 255, 255, 22), width=3)
    d.line([(cx + 22, NECK_Y + 4), (cx + 28, FOOT_Y + 3)], fill=(255, 255, 255, 58), width=2)
    d.line([(cx - 22, NECK_Y + 4), (cx - 28, FOOT_Y + 3)], fill=(0, 0, 0, 130), width=2)
    # 挂板：贴在屏幕下沿的一块窄条，把「屏幕」和「脖子」接起来。
    # 不画它，柱子直接从屏幕上长出来，接缝那道黑线会像个「倒 T 字」。
    blit(img, rr_patch(92, 8, 3, (44, 50, 60, 255), outline=(255, 255, 255, 40)),
         cx - 46, NECK_Y - 1)
    # 底座：下盘（宽）+ 上盘（窄、更亮）= 有厚度的感觉
    blit(img, rr_patch(238, 17, 8, (66, 74, 88, 255), outline=(255, 255, 255, 56)),
         cx - 119, FOOT_Y + 1)
    blit(img, rr_patch(196, 8, 4, (92, 102, 119, 255)),
         cx - 98, FOOT_Y + 1)

    # ---- 显示器外壳 ----
    # 边框比背景只亮一点点（23,27,33 vs 21,26,33），所以轮廓线得靠得住：
    # 原来 255/38 太淡，屏幕像是直接浮在背景上。抬到 62，并在顶边压一道高光。
    blit(img, rr_patch(MON_W, MON_H, 20, (26, 31, 38, 255),
                       outline=(255, 255, 255, 62), width=1), MON_X, MON_Y)
    d.line([(MON_X + 20, MON_Y + 1), (MON_X + MON_W - 20, MON_Y + 1)],
           fill=(255, 255, 255, 26), width=1)
    # 屏幕四周的一圈内沿，让「屏」和「框」分得开
    blit(img, rr_patch(SCR_W + 8, SCR_H + 8, 12, (8, 10, 13, 255)),
         SCR_X - 4, SCR_Y - 4)

    # ---- 屏幕内容 ----
    if err:
        d.rectangle((SCR_X, SCR_Y, SCR_X + SCR_W, SCR_Y + SCR_H), fill=(26, 12, 12, 255))
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
        badge = "闲时" if tier == 0 else f"档位{tier}"
        bw2 = int(d.textlength(badge, font=f(19, True))) + 20
        blit(img, rr_patch(bw2, 28, 8, (col[0], col[1], col[2], 40),
                           outline=(col[0], col[1], col[2], 110)), MON_X + 96, CAP_Y - 4)
        d.text((MON_X + 96 + bw2 // 2, CAP_Y + 10), badge, font=f(19, True),
               fill=col, anchor="mm")
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
        # 待机只留一行（2026-10-27 主人定的文案，别改）：
        #   「电脑待机中 - 刷礼物有惊喜」
        # 原来这里是「电脑待机中」+ 第二行小字「有人送礼就播素材 · 按礼物档位挑」，
        # 主人说小字不要，所以并成一句。字号提到 24，待机时它就是右栏的主视觉。
        d.text((MON_X, CAP_Y + 4), "电脑待机中 - 刷礼物有惊喜",
               font=f(24), fill=DIM)

    # ---- 把这一层半透明的东西合回去（只处理右栏那一小块，别整图过一遍）----
    box = _LAY_BOX
    region = lay.crop(box)
    img.paste(region, (box[0], box[1]), region)


def compose(st):
    """st 见 overlay.py；返回 1920×1080 RGB"""
    img = base(st).copy()
    draw_character(img, st)
    d = ImageDraw.Draw(img)
    f = lambda s, b=False: font(s, b, ss=False)

    # ---- 本场数据（数字会变） ----
    c1h = 32 + 36 + 3 * 46 + 10
    ry = CARD_Y + 30 + 60
    for val, col in (
        (st.get("chat", 0), INK),
        (st.get("gift", 0), GOLD),
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
           font=f(22), fill=GOLD if float(st.get('money', st.get('token', 0)) or 0) <= 1 else FAINT,
           anchor="ra")

    # ---- 右侧：礼物档位「电脑」展示区（2026-10-27 换掉原来的弹幕列） ----
    # 原来这里是自底向上的弹幕气泡。主人要求「移除用户评论区，换成电脑展示区」，
    # 所以默认走电脑；想看回弹幕就设环境变量 ZY_DANMAKU=1（代码没删，只是不画）。
    if DANMAKU_ON:
        draw_danmaku(img, st, d, f)
    else:
        draw_computer(img, st, d, f)

    # ---- 底部字幕 ----
    sub = st.get("subtitle")
    if sub:
        tag, fs_ = "说话", f(21)
        tw = d.textlength(tag, font=fs_)
        body_w = d.textlength(str(sub), font=f(34))
        # 按内容收窄：定宽 900 时短句右边会空一大片，看着像没画完。
        # 上限仍是 SUB_W（34px 字号下约 21 个汉字，超了本来就该截断），下限 520 免得短句挤成一条。
        bw2 = int(max(520, min(SUB_W, 30 + tw + 46 + body_w + 30))) // 4 * 4
        sx = (W - bw2) // 2
        sy2 = H - SUB_BOTTOM - SUB_H
        sh, pad = shadow_patch(bw2, SUB_H, 24, blur=12, alpha=130)
        blit(img, sh, sx - pad, sy2 - pad + 3)
        blit(img, rr_patch(bw2, SUB_H, 24, (8, 12, 16, 226)), sx, sy2)
        blit(img, rr_patch(int(tw) + 28, 34, 9, TEAL), sx + 30, sy2 + 26)
        d.text((sx + 44, sy2 + 32), tag, font=fs_, fill=(8, 18, 15, 255))
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


if __name__ == "__main__":
    main()
