#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抓任意窗口的内容存成 PNG —— 用来确认「直播伴侣能不能看见」。

用法：
  python native/grab.py                       # 自动找标题里带「直播画面」的窗口
  python native/grab.py "窗口标题" out.png

原理和 overlay.py --selftest 一样：PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)，
拿的是 DWM 合成后的像素。它能抓到，直播伴侣的「窗口捕捉」就能看到。
"""
import ctypes
import os
import sys
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

user32.FindWindowW.restype = wintypes.HWND
user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.CreateDIBSection.argtypes = [
    wintypes.HDC, ctypes.c_void_p, wintypes.UINT,
    ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD,
]
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]

ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [ENUMPROC, wintypes.LPARAM]


class BMIH(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
    ]


def find_windows(keyword):
    out = []

    def cb(hwnd, _):
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value
        if keyword in title and user32.IsWindowVisible(hwnd):
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            out.append((hwnd, title, r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(ENUMPROC(cb), 0)
    return out


def grab(hwnd, w, h, out):
    hdc_win = user32.GetDC(hwnd)
    hdc = gdi32.CreateCompatibleDC(hdc_win)
    bi = BMIH()
    bi.biSize = ctypes.sizeof(BMIH)
    bi.biWidth, bi.biHeight = w, -h
    bi.biPlanes, bi.biBitCount, bi.biCompression = 1, 32, 0
    pbits = ctypes.c_void_p()
    hbm = gdi32.CreateDIBSection(hdc, ctypes.byref(bi), 0, ctypes.byref(pbits), None, 0)
    gdi32.SelectObject(hdc, hbm)
    gdi32.GdiFlush()
    ok = user32.PrintWindow(hwnd, hdc, 2)
    gdi32.GdiFlush()
    img = Image.frombytes("RGB", (w, h), ctypes.string_at(pbits, w * h * 4), "raw", "BGRX")
    img.save(out)
    gdi32.DeleteObject(hbm)
    gdi32.DeleteDC(hdc)
    user32.ReleaseDC(hwnd, hdc_win)
    return ok, img


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else "直播画面"
    out = sys.argv[2] if len(sys.argv) > 2 else "grab.png"
    user32.SetProcessDPIAware()  # 不然坐标会被 DPI 虚拟化，量出来只有一半
    wins = find_windows(keyword)
    if not wins:
        print(f"没找到标题里带「{keyword}」的可见窗口。")
        print("画面窗口开着吗？可以用 open-overlay.cmd 打开。")
        return 1
    for hwnd, title, w, h in wins:
        cr = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(cr))
        print(f"找到：{title}  窗口 {w}×{h}  客户区 {cr.right}×{cr.bottom}")
        ok, img = grab(hwnd, w, h, out)
        px = img.getpixel((w // 2, h // 2))
        # 全黑说明这个窗口没画出东西（或者被别的窗口遮住又没在画）
        blank = px == (0, 0, 0)
        print(f"  PrintWindow={ok}  中心像素={px}  {'⚠ 疑似空白' if blank else '有内容'}  → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
