#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""text.toPdf 文本型字库再生成：public/fonts/text/NotoSansSC-{Regular,Bold}-Text.ttf。

背景：pdf-lib embedFont(subset:true) 对 CJK 字体产出损坏字形（mupdf 渲染报
invalid outline / cannot render glyph），因此 text.toPdf 以 subset:false 嵌入
fontTools 预子集字体：GB2312 全量 + ASCII + CJK 标点/全角 + 常用数学符号。
subset:false 嵌入产物经压缩后 ~1.36MB/字重，文本层可完整抽取（可框选/搜索/复制）。

字符集（去重后恰 7830 字，含间隔号 U+00B7）：
- ASCII 可见区 U+0020-007E；
- GB2312 双字节全区：hi 0xA1-0xF7 × lo 0xA1-0xFE，bytes([hi, lo]).decode('gb2312') 容错跳过空位；
- U+2000-206F（通用标点，含 • — “ ” 等）、U+3000-303F（CJK 符号）、U+FF00-FFEF（全角 forms）；
- 常用数学/单位符：² ³ ° ± · × ≈ ≠ ≤ ≥（U+00B2 U+00B3 U+00B0 U+00B1 U+00B7 U+00D7 U+2248 U+2260 U+2264 U+2265）。

等价手工命令（W ∈ Regular, Bold）：
  python3 -m fontTools.subset public/fonts/NotoSansSC-{W}.ttf \
    --text-file=<charset.txt> \
    --output-file=public/fonts/text/NotoSansSC-{W}-Text.ttf \
    --layout-features='' --no-hinting --desubroutinize

本脚本幂等：重复运行产出的字体与现有文件逐字节一致（fontTools 子集输出确定）。
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = ROOT / "public" / "fonts"
OUT_DIR = FONT_DIR / "text"

# 与上文文档一致的字符集（注意含 U+00B7 间隔号，去重后 7830 字）
EXTRA_CODEPOINTS = (0xB2, 0xB3, 0xB0, 0xB1, 0xB7, 0xD7, 0x2248, 0x2260, 0x2264, 0x2265)


def build_charset() -> str:
    chars = [chr(c) for c in range(0x20, 0x7F)]
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass  # GB2312 未定义空位
    chars += [chr(c) for c in range(0x2000, 0x2070)]   # U+2000-206F 通用标点
    chars += [chr(c) for c in range(0x3000, 0x3040)]   # U+3000-303F CJK 符号
    chars += [chr(c) for c in range(0xFF00, 0xFFF0)]   # U+FF00-FFEF 全角 forms
    chars += [chr(c) for c in EXTRA_CODEPOINTS]
    return "".join(dict.fromkeys(chars))  # 去重且保序


def main() -> int:
    charset = build_charset()
    print(f"charset: {len(charset)} 字符")
    charset_file = OUT_DIR / ".charset.txt"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    charset_file.write_text(charset, encoding="utf-8")
    for weight in ("Regular", "Bold"):
        src = FONT_DIR / f"NotoSansSC-{weight}.ttf"
        dst = OUT_DIR / f"NotoSansSC-{weight}-Text.ttf"
        if not src.is_file():
            print(f"缺源字体：{src}（先运行 bash scripts/build_fonts.sh）", file=sys.stderr)
            return 1
        cmd = [
            sys.executable, "-m", "fontTools.subset", str(src),
            f"--text-file={charset_file}",
            f"--output-file={dst}",
            "--layout-features=",
            "--no-hinting",
            "--desubroutinize",
        ]
        print("$", " ".join(cmd))
        subprocess.run(cmd, check=True)
        print(f"→ {dst}（{dst.stat().st_size} bytes）")
    charset_file.unlink()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
