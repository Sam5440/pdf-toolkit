#!/usr/bin/env python3
"""构建内置中文字体子集（渲染回退用）。

从 4 个开源中文字体生成 GB2312+常用符号 的 woff2 子集，输出到 public/fonts/cn/：
  - noto-sans   思源黑体（Noto Sans CJK SC）  → 黑体/微软雅黑/华文黑体/等线 等回退
  - noto-serif  思源宋体（Noto Serif CJK SC）  → 宋体/华文宋体/华文中宋 等回退
  - wenkai      霞鹜文楷 GB（LXGW WenKai GB）  → 楷体/华文楷体 回退
  - zhuque      朱雀仿宋（Zhuque Fangsong）    → 仿宋/华文仿宋 回退

子集按 OFL「修改版须改名」条款统一改内部字体名为 PTK-*（PTK = PDF Toolkit），
OFL 许可文本随文件存于 public/fonts/cn/LICENSES.md。
woff2 压缩需要 fonttools + brotli：pip3 install fonttools brotli
用法: python3 scripts/build_cn_fonts.py [--out 目录] [--only id] [--skip-download]
"""
import argparse
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT / "public" / "fonts" / "cn"
UA = {"User-Agent": "Mozilla/5.0 (pdf-toolkit font builder)"}

# GB2312 全表 + ASCII + 常用标点/符号补充（覆盖中文文档 99%+ 用字；
# 生僻字不在子集内，回退渲染时由浏览器按字符继续回退系统字体）。
def collect_charset():
    chars = set(chr(c) for c in range(0x20, 0x7F))
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    ranges = [
        (0x00A0, 0x00FF),  # 拉丁-1：°±×÷©®¥ 等
        (0x2010, 0x2027),  # ‐ – — ‘ ’ “ ” … ‰ ′ ″ ※
        (0x2030, 0x203B),
        (0x20AC, 0x20AC),  # €
        (0x2103, 0x2103),  # ℃
        (0x2122, 0x2122),  # ™
        (0x2190, 0x2193),  # ← ↑ → ↓
        (0x2460, 0x2473),  # ①-⑳
        (0x25A0, 0x25CF),  # ■□▲△▶◀●○
        (0x2605, 0x2606),  # ★☆
        (0x2713, 0x2717),  # ✓✗
        (0x3000, 0x303F),  # CJK 标点：。、《》「」『』【】 等
        (0xFF00, 0xFFEF),  # 全角形式：，！？ＡＢ１２ ￥ 等
    ]
    for a, b in ranges:
        chars.update(chr(c) for c in range(a, b + 1))
    return chars

FONTS = [
    {
        "id": "noto-sans",
        "internal": "PTK Sans SC",
        "src": "Noto Sans CJK SC",
        "url": "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf",
        "license": "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE",
    },
    {
        "id": "noto-serif",
        "internal": "PTK Serif SC",
        "src": "Noto Serif CJK SC",
        "url": "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/SubsetOTF/SC/NotoSerifSC-Regular.otf",
        "license": "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/LICENSE",
    },
    {
        "id": "wenkai",
        "internal": "PTK Kai GB",
        "src": "LXGW WenKai GB (https://github.com/lxgw/LxgwWenkaiGB)",
        "release": "https://api.github.com/repos/lxgw/LxgwWenkaiGB/releases/latest",
        "asset": "LXGWWenKaiGB-Regular.ttf",
        "license": "https://raw.githubusercontent.com/lxgw/LxgwWenkaiGB/main/OFL.txt",
    },
    {
        "id": "zhuque",
        "internal": "PTK Fangsong",
        "src": "Zhuque Fangsong (https://github.com/TrionesType/zhuque)",
        "release": "https://api.github.com/repos/TrionesType/zhuque/releases/latest",
        "asset_prefix": "ZhuqueFangsong-",
        "license": "https://raw.githubusercontent.com/TrionesType/zhuque/main/OFL.txt",
    },
]


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def resolve_asset_url(item):
    # 仓库可能只有 prerelease（releases/latest 会 404），统一走列表取最新一条
    info = json.loads(fetch(item["release"].replace("/latest", "?per_page=1")))[0]
    tag = info["tag_name"]
    prefix = item.get("asset_prefix")
    exact = item.get("asset")
    for a in info.get("assets", []):
        name = a["name"]
        ok_font = (exact and name == exact) or (prefix and name.startswith(prefix) and name.endswith((".ttf", ".otf")))
        ok_zip = prefix and name.startswith(prefix) and name.endswith(".zip")
        if ok_font or ok_zip:
            return a["browser_download_url"], f"{tag}-{name}"
    raise SystemExit(f"[{item['id']}] release {tag} 中找不到字体资产（{exact or prefix}）")


def obtain_source(item, raw_dir):
    """返回解压后的源字体路径（缓存于 scripts/.cn-fonts-src/）"""
    raw_dir.mkdir(parents=True, exist_ok=True)
    if "url" in item:
        name = item["url"].rsplit("/", 1)[-1]
        dst = raw_dir / name
        if not dst.exists():
            print(f"[{item['id']}] 下载 {item['url']}")
            dst.write_bytes(fetch(item["url"]))
        return dst
    url, name = resolve_asset_url(item)
    dst = raw_dir / name
    if not dst.exists():
        print(f"[{item['id']}] 下载 {url}")
        data = fetch(url)
        if name.endswith(".zip"):
            zf = zipfile.ZipFile(io.BytesIO(data))
            inner = [n for n in zf.namelist() if n.lower().endswith(("regular.ttf", "regular.otf"))
                     and not Path(n).name.startswith("._")]
            if not inner:
                raise SystemExit(f"[{item['id']}] zip 内无 Regular 字体：{zf.namelist()[:10]}")
            dst.write_bytes(zf.read(inner[0]))
        else:
            dst.write_bytes(data)
    return dst


def rename_family(font, new_name):
    """OFL 修改版条款：子集为修改版，内部名改为 PTK-* 中性名"""
    from fontTools.ttLib import TTFont
    name_table = font["name"]
    for rec in list(name_table.names):
        if rec.nameID in (1, 3, 4, 6, 16, 17, 21, 22):
            name_table.removeNames(rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        name_table.setName(new_name, 1, pid, eid, lid)
        name_table.setName(new_name, 3, pid, eid, lid)
        name_table.setName(new_name, 4, pid, eid, lid)
        name_table.setName(new_name.replace(" ", ""), 6, pid, eid, lid)


def build_subset(item, src_path, out_dir):
    from fontTools import subset

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]  # 保留 vert 等排版特性（竖排中文）
    opts.name_IDs = ["*"]
    opts.notdef_outline = True  # 保留 .notdef 轮廓（缺字时显示方框而非空白）
    chars = collect_charset()
    unicodes = sorted(ord(c) for c in chars)

    font = subset.load_font(src_path, opts)
    subsetter = subset.Subsetter(opts)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    rename_family(font, item["internal"])

    dst = out_dir / f"{item['id']}.woff2"
    buf = io.BytesIO()
    subset.save_font(font, buf, opts)
    dst.write_bytes(buf.getvalue())
    return dst, len(buf.getvalue()), font["maxp"].numGlyphs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--only", help="只构建指定 id（逗号分隔）")
    ap.add_argument("--skip-download", action="store_true", help="只用已下载的源字体")
    args = ap.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = ROOT / "scripts" / ".cn-fonts-src"

    only = set(args.only.split(",")) if args.only else None
    lines = ["# 内置中文字体（渲染回退子集）\n",
             "以下文件均为 SIL Open Font License 1.1 开源字体的 GB2312+ 常用字符子集，",
             "按 OFL 修改版条款将内部字体名改为 PTK-*（PTK = PDF Toolkit）。\n"]
    total = 0
    for item in FONTS:
        if only and item["id"] not in only:
            continue
        src_path = None
        if not args.skip_download:
            src_path = obtain_source(item, raw_dir)
        else:
            candidates = sorted(raw_dir.glob("*.ttf")) + sorted(raw_dir.glob("*.otf"))
            key = item["id"].split("-")[-1]
            src_path = next((c for c in candidates if key in c.name.lower() or "sc" in c.name.lower()), None)
            if not src_path:
                raise SystemExit(f"[{item['id']}] --skip-download 但未找到源字体")
        dst, size, glyphs = build_subset(item, src_path, out_dir)
        total += size
        print(f"[{item['id']}] {dst.name}  {size / 1048576:.2f} MB  {glyphs} glyphs  (from {item['src']})")
        lines.append(f"## {dst.name}\n\n- 来源：{item['src']}（SIL OFL 1.1）\n- 许可：{item['license']}\n")

    (out_dir / "LICENSES.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"合计 {total / 1048576:.2f} MB → {out_dir}")


if __name__ == "__main__":
    sys.exit(main())
