#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成几份示例素材，方便一上手就能看到效果。

文件命名规则（桥和设置页都按这个认档位）：
    <档位>-<随便什么>.<扩展名>
    1-小心心.png   2-棒棒糖.gif   3-跑车.mp4   4-嘉年华.webp

档位就是文件名开头那个数字，必须是 1~4。想加素材直接丢文件进去，
不用改任何配置 —— 桥每隔几秒扫一次目录。

用法：python tools/make-demo-media.py
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MEDIA = os.path.join(ROOT, "media")

W, H = 640, 360  # 16:9，跟展示区的屏幕比例一致


def font(size):
    for p in (
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
    ):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def card(title, sub, tint, tag):
    img = Image.new("RGB", (W, H), tint)
    d = ImageDraw.Draw(img)
    # 底纹：斜条纹，避免大面积纯色显得像没加载出来
    for x in range(-H, W, 48):
        d.line([(x, H), (x + H, 0)], fill=tuple(min(255, c + 10) for c in tint), width=14)
    d.rounded_rectangle([24, 24, W - 24, H - 24], radius=22, outline=(255, 255, 255, 90), width=3)
    d.text((W // 2, H // 2 - 34), title, font=font(64), fill=(255, 255, 255), anchor="mm")
    d.text((W // 2, H // 2 + 38), sub, font=font(28), fill=(255, 255, 255, 210), anchor="mm")
    d.text((W - 44, H - 44), tag, font=font(24), fill=(255, 255, 255, 150), anchor="rs")
    return img


def main():
    os.makedirs(MEDIA, exist_ok=True)

    specs = [
        ("1-小心心.png", "小心心", "档位 1 · 小额礼物", (38, 84, 124), "示例素材"),
        ("3-跑车.png", "跑车", "档位 3 · 大额礼物", (124, 52, 38), "示例素材"),
    ]
    for name, title, sub, tint, tag in specs:
        p = os.path.join(MEDIA, name)
        card(title, sub, tint, tag).save(p)
        print("写入", p)

    # 档位 2：动图（三帧呼吸效果），验证 GIF 逐帧
    frames = []
    for i in range(12):
        img = card("棒棒糖", "档位 2 · 中额礼物", (72, 40, 110), "示例素材 · 动图")
        d = ImageDraw.Draw(img)
        r = 46 + int(14 * abs((i % 12) - 6) / 6 * 2)
        cx, cy = W - 96, 96
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 176, 210))
        d.ellipse([cx - r // 3, cy - r // 3, cx + r // 3, cy + r // 3], fill=(255, 255, 255))
        frames.append(img.convert("P", palette=Image.ADAPTIVE, colors=128))
    p2 = os.path.join(MEDIA, "2-棒棒糖.gif")
    frames[0].save(p2, save_all=True, append_images=frames[1:], duration=90, loop=0)
    print("写入", p2)

    # 档位 4：动图，验证「特效档」单独指定
    f4 = []
    for i in range(16):
        img = card("嘉年华", "档位 4 · 特效礼物", (96, 74, 20), "示例素材 · 动图")
        d = ImageDraw.Draw(img)
        for k in range(8):
            a = (i / 16.0) * 6.283 + k * 0.785
            import math

            x = W // 2 + int(200 * math.cos(a))
            y = H // 2 + int(120 * math.sin(a))
            d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(255, 214, 92))
        f4.append(img.convert("P", palette=Image.ADAPTIVE, colors=128))
    p4 = os.path.join(MEDIA, "4-嘉年华.gif")
    f4[0].save(p4, save_all=True, append_images=f4[1:], duration=80, loop=0)
    print("写入", p4)

    readme = os.path.join(MEDIA, "说明.txt")
    with open(readme, "w", encoding="utf-8") as f:
        f.write(
            "礼物档位媒体素材\n"
            "================\n\n"
            "文件命名：<档位>-<随便什么>.<扩展名>\n"
            "  例：1-小心心.mp4   2-棒棒糖.gif   3-跑车.png   4-嘉年华.webp\n\n"
            "档位 = 文件名开头那个数字（1~4）。同一档位可以放任意多个文件，\n"
            "设置页里选「随机」或「顺序」决定怎么挑。\n\n"
            "支持的格式：\n"
            "  图片  png / jpg / jpeg / webp / bmp / gif（gif 会逐帧播）\n"
            "  视频  mp4 / webm / mov / mkv\n"
            "  音频  mp3 / wav / m4a / aac / ogg（屏幕显示波形，声音走系统默认输出）\n\n"
            "加完文件不用重启，桥每 3 秒扫一次目录。\n"
            "带「示例素材」字样的几张是脚本生成的占位图，可以直接删。\n"
        )
    print("写入", readme)
    print("\n完成。目录：", MEDIA)


if __name__ == "__main__":
    sys.exit(main())
