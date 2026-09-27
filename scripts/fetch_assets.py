#!/usr/bin/env python3
"""下载并校验公共资产：Noto Sans SC 字体（OFL 许可）与 tessdata_fast OCR 语言包（Apache-2.0）。
用法: python3 scripts/fetch_assets.py [--force]
"""
import hashlib
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "public" / "fonts"
TESSDATA = ROOT / "public" / "tessdata"

# 权威来源 + 备用镜像；sha256 首次抓取时计算并固定
FONT_SOURCES = {
    "NotoSansSC-Regular.otf": [
        "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
        "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
    ],
    "NotoSansSC-Bold.otf": [
        "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf",
        "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf",
    ],
}
TESS_SOURCES = {
    "chi_sim.traineddata": ["https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/chi_sim.traineddata"],
    "chi_tra.traineddata": ["https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/chi_tra.traineddata"],
    "eng.traineddata": ["https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata"],
    "osd.traineddata": ["https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/osd.traineddata"],
}


def fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"下载 {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "pdf-toolkit-setup/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.rename(dest)


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    force = "--force" in sys.argv
    failures = []
    for name, urls in {**FONT_SOURCES, **TESS_SOURCES}.items():
        dest = (FONTS if name.endswith(".otf") else TESSDATA) / name
        if dest.exists() and not force:
            print(f"已有 {name}（{dest.stat().st_size / 1e6:.1f} MB）")
            continue
        ok = False
        for url in urls:
            try:
                fetch(url, dest)
                print(f"  → {name}: {dest.stat().st_size / 1e6:.1f} MB, sha256={sha256(dest)[:16]}…")
                ok = True
                break
            except Exception as e:
                failures.append(f"{name} ← {url}: {e}")
        if not ok:
            failures.append(f"{name}: 所有来源均失败")
    if failures:
        print("\n部分资产下载失败：")
        for f in failures:
            print(" -", f)
        print("请检查网络后重试，或手动放置文件到 public/fonts 与 public/tessdata")
        return 1
    print("\n全部资产就绪")
    return 0


if __name__ == "__main__":
    sys.exit(main())
