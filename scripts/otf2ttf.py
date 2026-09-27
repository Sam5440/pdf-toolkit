#!/usr/bin/env python3
"""OTF(CFF) → TTF(glyf) 转换（fontTools canonical 配方）。

背景：pdf-lib/fontkit 对 CFF flavor 字体 subset:true 会产出损坏的字体程序
（FT_New_Memory_Face: unknown file format，水印中文不可见）；对 TrueType flavor
的子集化是成熟路径。故构建期统一转 TTF。

配方要点（缺一不可，缺了会"部分字形渲染空白"）：
  1. Cu2QuPen + TTGlyphPen 逐字形转二次贝塞尔；
  2. glyf.compile(font) 显式编译（重算每字形 bbox）；
  3. 用 xMin 回写 hmtx 的 lsb；
  4. maxp 在 glyf 之后编译（统计 maxPoints/maxContours 等）。
用法: python3 scripts/otf2ttf.py input.otf output.ttf
"""
import sys
import time

from fontTools.ttLib import TTFont, newTable
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

MAX_ERR = 1.0
POST_FORMAT = 2.0


def glyphs_to_quadratic(glyphOrder, glyphSet, max_err=MAX_ERR, reverse_direction=True):
    quadGlyphs = {}
    for gname in glyphOrder:
        glyph = glyphSet[gname]
        ttPen = TTGlyphPen(glyphSet)
        cu2quPen = Cu2QuPen(ttPen, max_err, reverse_direction=reverse_direction)
        glyph.draw(cu2quPen)
        quadGlyphs[gname] = ttPen.glyph()
    return quadGlyphs


def update_hmtx(font, glyf):
    hmtx = font["hmtx"]
    for glyphName, glyph in glyf.glyphs.items():
        if hasattr(glyph, "xMin"):
            hmtx[glyphName] = (hmtx[glyphName][0], glyph.xMin)


def otf_to_ttf(font):
    assert font.sfntVersion == "OTTO"
    assert "CFF " in font

    glyphOrder = font.getGlyphOrder()
    font["loca"] = newTable("loca")
    font["glyf"] = glyf = newTable("glyf")
    glyf.glyphOrder = glyphOrder
    glyf.glyphs = glyphs_to_quadratic(glyphOrder, font.getGlyphSet())
    del font["CFF "]
    if "VORG" in font:
        del font["VORG"]
    glyf.compile(font)
    update_hmtx(font, glyf)

    font["maxp"] = maxp = newTable("maxp")
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = max(
        (len(g.components) for g in glyf.glyphs.values() if hasattr(g, "components")),
        default=0,
    )
    maxp.compile(font)

    post = font["post"]
    post.formatType = POST_FORMAT
    post.extraNames = []
    post.mapping = {}
    post.glyphOrder = None

    font.sfntVersion = "\x00\x01\x00\x00"
    return font


def main():
    src, dst = sys.argv[1], sys.argv[2]
    t0 = time.time()
    f = TTFont(src)
    otf_to_ttf(f)
    f.save(dst)
    print(f"{src} -> {dst}: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
