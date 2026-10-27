#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""大肥鱼抠图：从四边泛洪去掉纯白底，保留角色内部的白色（围裙、头饰）。

为什么用泛洪而不是「所有白像素都透明」：
角色的围裙和头饰也是白的，被深色描边包住 → 从边缘泛洪进不去，
所以只吃掉连到画布边缘的那片白。
"""
import os
import sys
from collections import deque
from PIL import Image, ImageFilter

# 路径跟着脚本走，整个目录挪到哪都能跑
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")
SRC = os.path.join(ASSETS, "dafeiyu-src.jpg")
OUT = os.path.join(ASSETS, "dafeiyu.png")
FACE = os.path.join(ASSETS, "dafeiyu-face.png")

# 泛洪判「白」的阈值：三个通道都不低于 T，且互相差异不超过 S
T = 242
S = 10


def knockout(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    w, h = img.size
    px = img.load()

    is_white = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            r, g, b = px[x, y]
            if r >= T and g >= T and b >= T and max(r, g, b) - min(r, g, b) <= S:
                is_white[row + x] = 1

    bg = bytearray(w * h)
    q = deque()

    def push(x, y):
        i = y * w + x
        if is_white[i] and not bg[i]:
            bg[i] = 1
            q.append(i)

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    while q:
        i = q.popleft()
        x, y = i % w, i // w
        if x > 0:
            push(x - 1, y)
        if x < w - 1:
            push(x + 1, y)
        if y > 0:
            push(x, y - 1)
        if y < h - 1:
            push(x, y + 1)

    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if bg[row + x]:
                ap[x, y] = 0

    # 边缘半透明：贴着背景的那一圈前景像素按「有多白」给 alpha，
    # 深色描边（w 小）保持不透明，JPEG 白边（w≈1）几乎消失
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if bg[i]:
                continue
            near = False
            if x > 0 and bg[i - 1]:
                near = True
            elif x < w - 1 and bg[i + 1]:
                near = True
            elif y > 0 and bg[i - w]:
                near = True
            elif y < h - 1 and bg[i + w]:
                near = True
            if not near:
                continue
            r, g, b = px[x, y]
            wness = min(r, g, b) / 255.0
            if wness > 0.86:
                ap[x, y] = int(255 * max(0.0, (1.0 - wness) / 0.14) * 0.75)

    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
    out = img.convert("RGBA")
    out.putalpha(alpha)
    return out


def main():
    src = Image.open(SRC)
    print("原图", src.size, src.mode)
    cut = knockout(src)

    bbox = cut.getbbox()
    print("裁剪框", bbox)
    pad = 8
    x0, y0, x1, y1 = bbox
    x0 = max(0, x0 - pad)
    y0 = max(0, y0 - pad)
    x1 = min(cut.width, x1 + pad)
    y1 = min(cut.height, y1 + pad)
    cut = cut.crop((x0, y0, x1, y1))
    cut.save(OUT)
    print("输出", OUT, cut.size)

    # 头像用：头部区域。实测脸（含眼睛到下巴）大约在裁剪后高度的 11%~57%
    w, h = cut.size
    top = int(h * 0.21)
    head_h = int(h * 0.38)
    cx = w // 2
    half = head_h // 2
    face = cut.crop((max(0, cx - half), top, min(w, cx + half), top + head_h))
    face.save(FACE)
    print("头像", FACE, face.size)


if __name__ == "__main__":
    main()
