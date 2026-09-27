#!/usr/bin/env bash
# 字体资产构建：Noto Sans SC 官方可变 TTF → instancer 实例化 → 字符集子集
# 背景：
# 1) 原打包的 OTF(CFF) 经 pdf-lib subset:true 会产出损坏字体程序（水印中文不可见）；
# 2) 自写 OTF→TTF 转换（fontTools cu2qu）仍有字形映射错位；
# 3) 最终方案：Google Fonts 官方可变字体（TrueType flavor）实例化 + fontTools 子集，
#    pdf-lib 侧 CJK 一律 subset:false 或栅格化（见 src/core/fonts.js ensureCJKFontFace 说明）。
# 用法: bash scripts/build_fonts.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VAR_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf"
VAR_TTF="/tmp/NotoSansSC-var.ttf"
UNICODES="U+0020-007E,U+00A0-00FF,U+0370-03FF,U+0400-04FF,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2E80-2EFF,U+3000-303F,U+3130-318F,U+3190-319F,U+31F0-31FF,U+3200-32FF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF"

if [ ! -f "$VAR_TTF" ]; then
  echo "下载可变字体…"
  curl -sL -o "$VAR_TTF" "$VAR_URL"
fi

python3 -m fontTools.varLib.instancer "$VAR_TTF" wght=400 -o /tmp/NotoSansSC-i400.ttf
python3 -m fontTools.varLib.instancer "$VAR_TTF" wght=700 -o /tmp/NotoSansSC-i700.ttf
python3 -m fontTools.subset /tmp/NotoSansSC-i400.ttf --unicodes="$UNICODES" \
  --output-file=public/fonts/NotoSansSC-Regular.ttf --layout-features='*' --no-hinting
python3 -m fontTools.subset /tmp/NotoSansSC-i700.ttf --unicodes="$UNICODES" \
  --output-file=public/fonts/NotoSansSC-Bold.ttf --layout-features='*' --no-hinting
echo "完成：public/fonts/NotoSansSC-{Regular,Bold}.ttf"
