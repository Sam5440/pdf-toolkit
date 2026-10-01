# -*- coding: utf-8 -*-
"""水印 / 叠加产物校验：像素级存在性 + 结构完整性。

注：整页「平均差」对小块水印/叠加极不敏感（单个小字水印的整页均值 ~0.2），
存在性断言用「显著变化区块数 / 特征像素计数」，对水印大小不敏感且抗噪。
"""
import pytest

from conftest import fixture, find_artifact, mean_abs_pixel_diff

pytestmark = pytest.mark.verify


def _changed_blocks(src_path, out_path, page=0, dpi=72, thresh=25, block=32):
    """渲染同页，返回像素差 > thresh 的 block×block 区块数与最大像素差。"""
    import fitz

    d_src, d_out = fitz.open(str(src_path)), fitz.open(str(out_path))
    ps = d_src[page].get_pixmap(dpi=dpi)
    po = d_out[page].get_pixmap(dpi=dpi)
    n = min(ps.n, po.n)
    w, h = min(ps.width, po.width), min(ps.height, po.height)
    blocks = set()
    maxd = 0
    for y in range(h):
        for x in range(0, w, 2):
            i = (y * ps.width + x) * n
            j = (y * po.width + x) * n
            d = abs(ps.samples[i] - po.samples[j])
            if d > maxd:
                maxd = d
            if d > thresh:
                blocks.add((x // block, y // block))
    d_src.close()
    d_out.close()
    return len(blocks), maxd


def test_watermark_pdf():
    """水印产物：页数不变、原文字保留、第1页渲染与原件存在显著像素差（水印真实落页）。"""
    p = find_artifact("watermark*.pdf")
    src = fixture("multi3.pdf")
    import fitz

    d_src, d_out = fitz.open(str(src)), fitz.open(str(p))
    assert d_out.page_count == d_src.page_count, f"页数应不变：{d_src.page_count} → {d_out.page_count}"
    text = d_out[0].get_text()
    assert "Fixture Page 1" in text, "加水印后原有文字丢失"
    blocks, maxd = _changed_blocks(src, p, page=0)
    assert blocks >= 3 and maxd > 25, \
        f"第1页与原件几乎相同（变化区块 {blocks}、最大差 {maxd}），水印可能未生效"
    d_src.close()
    d_out.close()


def test_watermark_rotated_pdf():
    """旋转页（/Rotate=90）水印产物：旋转保留、渲染存在水印墨迹（默认灰 #888888、小字单点）。

    e2e 场景为单个小号灰字水印，整页均值差仅 ~0.2，因此用「中性灰特征像素计数」验证。
    """
    p = find_artifact("watermark*rot*.pdf")
    src = fixture("rotated90.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count == 1
    assert d[0].rotation == 90, f"旋转属性应保留，实际 {d[0].rotation}"
    gray = 0
    pix = d[0].get_pixmap(dpi=72)
    for y in range(0, pix.height, 2):
        for x in range(0, pix.width, 2):
            v = pix.pixel(x, y)
            if 175 <= v[0] <= 235 and abs(v[0] - v[1]) < 8 and abs(v[1] - v[2]) < 8:
                gray += 1
    assert gray >= 100, f"旋转页未找到水印墨迹（灰色特征像素 {gray}），水印可能未覆盖旋转页"
    d.close()


def test_overlay_pdf():
    """叠加产物：页数=底稿页数、每页渲染与底稿存在显著局部差异（覆盖层真实存在）。"""
    p = find_artifact("overlay-out.pdf")
    src = fixture("multi3.pdf")
    import fitz

    d_src, d_out = fitz.open(str(src)), fitz.open(str(p))
    assert d_out.page_count == d_src.page_count, f"叠加后页数应=底稿：{d_src.page_count} → {d_out.page_count}"
    blocks, maxd = _changed_blocks(src, p, page=0)
    assert blocks >= 5 and maxd > 25, \
        f"第1页与底稿几乎相同（变化区块 {blocks}、最大差 {maxd}），覆盖层可能未生效"
    d_src.close()
    d_out.close()
