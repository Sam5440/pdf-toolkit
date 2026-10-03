#!/usr/bin/env bash
# 图标验收脚本：对 src/assets/icons/*.svg（单色）与 src/assets/icons-color/*.svg（多彩）
# 逐个检查契约合规性
# 用法: bash scripts/check-icons.sh [--color] [图标id...]
#   （缺省=单色方案全部；--color=多彩方案全部）
set -uo pipefail
cd "$(dirname "$0")/.."

COLOR=0
IDS=()
for a in "$@"; do
  if [ "$a" = "--color" ]; then COLOR=1; else IDS+=("$a"); fi
done

DIR="src/assets/icons"
if [ "$COLOR" = "1" ]; then DIR="src/assets/icons-color"; fi

# 多彩方案调色板白名单（docs/ICON-GUIDELINES.md §多彩手绘方案规范）
PALETTE='#3B82F6|#0EA5E9|#14B8A6|#22C55E|#F59E0B|#F97316|#EF4444|#8B5CF6|#EC4899|#64748B'

if [ ${#IDS[@]} -eq 0 ]; then
  IDS=()
  for fpath in "$DIR"/*.svg; do
    [ -e "$fpath" ] || continue
    IDS+=("$(basename "$fpath" .svg)")
  done
fi
FAIL=0
for id in "${IDS[@]}"; do
  f="$DIR/$id.svg"
  if [ ! -f "$f" ]; then echo "✗ $id: 文件不存在"; FAIL=1; continue; fi
  python3 - "$f" "$COLOR" "$PALETTE" <<'PY'
import sys, re, xml.etree.ElementTree as ET
f, color, palette = sys.argv[1], sys.argv[2] in ('1', 'True'), sys.argv[3].split('|')
errs = []
try:
    root = ET.parse(f).getroot()
except Exception as e:
    print(f"✗ {f}: XML 解析失败 {e}"); sys.exit(1)
if root.get('viewBox') != '0 0 48 48': errs.append(f"viewBox={root.get('viewBox')} 应为 0 0 48 48")
if 'http://www.w3.org/2000/svg' not in (root.tag or ''): errs.append("缺 xmlns")
s = open(f).read()
if color:
    if 'currentColor' in s: errs.append("多彩方案禁止 currentColor")
    used = set(re.findall(r'(?:stroke|fill)="(#[0-9A-Fa-f]{6})"', s))
    bad = used - set(palette)
    if bad: errs.append(f"调色板外颜色: {sorted(bad)}")
    if 'rotate(-2 24 24)' not in s: errs.append("缺统一微倾 rotate(-2 24 24)")
else:
    if 'currentColor' not in s: errs.append("未使用 currentColor")
for bad in ('<text', '<style', 'url(', 'Gradient', 'gradient', 'filter'):
    if bad in s: errs.append(f"禁止元素: {bad}")
n = sum(s.count(f'<{t}') for t in ('rect', 'circle', 'path', 'line', 'ellipse', 'polyline', 'polygon'))
cap = 10 if color else 12
if n > cap: errs.append(f"图元过多: {n} > {cap}")
if errs:
    print(f"✗ {f}: {'; '.join(errs)}")
else:
    print(f"✓ {f}: 合规（图元 {n}）")
sys.exit(1 if errs else 0)
PY
  [ $? -ne 0 ] && FAIL=1
done
exit $FAIL
