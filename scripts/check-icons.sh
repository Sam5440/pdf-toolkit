#!/usr/bin/env bash
# 图标验收脚本：对 src/assets/icons/*.svg 逐个检查契约合规性
# 用法: bash scripts/check-icons.sh [图标id...]（缺省=全部）
set -uo pipefail
cd "$(dirname "$0")/.."

IDS=("$@")
if [ ${#IDS[@]} -eq 0 ]; then
  IDS=()
  for fpath in src/assets/icons/*.svg; do
    [ -e "$fpath" ] || continue
    IDS+=("$(basename "$fpath" .svg)")
  done
fi
FAIL=0
for id in "${IDS[@]}"; do
  f="src/assets/icons/$id.svg"
  if [ ! -f "$f" ]; then echo "✗ $id: 文件不存在"; FAIL=1; continue; fi
  python3 - "$f" <<'PY'
import sys, xml.etree.ElementTree as ET
f = sys.argv[1]
errs = []
try:
    root = ET.parse(f).getroot()
except Exception as e:
    print(f"✗ {f}: XML 解析失败 {e}"); sys.exit(1)
if root.get('viewBox') != '0 0 48 48': errs.append(f"viewBox={root.get('viewBox')} 应为 0 0 48 48")
if 'http://www.w3.org/2000/svg' not in (root.tag or ''): errs.append("缺 xmlns")
s = open(f).read()
if 'currentColor' not in s: errs.append("未使用 currentColor")
for bad in ('<text', '<style', 'url(', 'Gradient', 'gradient', 'filter'):
    if bad in s: errs.append(f"禁止元素: {bad}")
n = sum(s.count(f'<{t}') for t in ('rect', 'circle', 'path', 'line', 'ellipse', 'polyline', 'polygon'))
if n > 12: errs.append(f"图元过多: {n} > 12")
if errs:
    print(f"✗ {f}: {'; '.join(errs)}")
else:
    print(f"✓ {f}: 合规（图元 {n}）")
sys.exit(1 if errs else 0)
PY
  [ $? -ne 0 ] && FAIL=1
done
exit $FAIL
