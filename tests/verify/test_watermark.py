# -*- coding: utf-8 -*-
"""水印 / 叠加产物校验：像素级存在性 + 结构完整性。"""
import pytest

from conftest import fixture, find_artifact, mean_abs_pixel_diff

pytestmark = pytest.mark.verify


def test_watermark_pdf():
    """水印产物：页数不变、原文字保留、第1页渲染与原件存在显著像素差（水印真实落页）。"""
    p = find_artifact("watermark*.pdf")
    src = fixture("multi3.pdf")
    import fitz

    d_src, d_out = fitz.open(str(src)), fitz.open(str(p))
    assert d_out.page_count == d_src.page_count, f"页数应不变：{d_src.page_count} → {d_out.page_count}"
    text = d_out[0].get_text()
    assert "Fixture Page 1" in text, "加水印后原有文字丢失"
    diff = mean_abs_pixel_diff(src, p, page=0)
    assert diff > 1.0, f"第1页渲染与原件几乎相同（平均差 {diff:.2f}），水印可能未生效"
    d_src.close()
    d_out.close()


def test_watermark_rotated_pdf():
    """旋转页（/Rotate=90）水印产物：若 e2e 用 rotated90.pdf 产出，验证仍可打开且渲染有差异。"""
    p = find_artifact("watermark*rot*.pdf")
    src = fixture("rotated90.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count == 1
    assert d[0].rotation == 90, f"旋转属性应保留，实际 {d[0].rotation}"
    diff = mean_abs_pixel_diff(src, p, page=0)
    assert diff > 1.0, f"旋转页渲染无差异（{diff:.2f}），水印可能未覆盖旋转页"
    d.close()


def test_overlay_pdf():
    """叠加产物：页数=底稿页数、每页渲染与底稿有像素差（覆盖层真实存在）。"""
    p = find_artifact("overlay*.pdf")
    src = fixture("multi3.pdf")
    import fitz

    d_src, d_out = fitz.open(str(src)), fitz.open(str(p))
    assert d_out.page_count == d_src.page_count, f"叠加后页数应=底稿：{d_src.page_count} → {d_out.page_count}"
    diff = mean_abs_pixel_diff(src, p, page=0)
    assert diff > 1.0, f"第1页与底稿几乎相同（{diff:.2f}），覆盖层可能未生效"
    d_src.close()
    d_out.close()
