# -*- coding: utf-8 -*-
"""文本/OCR 产物校验：.txt 内容 + 可搜索 PDF 双要素。"""
import pytest

from conftest import fixture, find_artifact

pytestmark = pytest.mark.verify


def test_text_extract_txt():
    """文本提取产物：utf-8 可读、含 multi3 已知英文文字。"""
    p = find_artifact("text*.txt")
    data = p.read_bytes()
    text = data.decode("utf-8")
    assert "Fixture Page 1" in text, f"文本产物缺少已知内容，前200字：{text[:200]!r}"


def test_ocr_pdf_searchable():
    """OCR 可搜索 PDF：每页含图像（页面图）+ 至少一页有文字层。"""
    p = find_artifact("ocr*.pdf")
    src = fixture("scan2.pdf")
    import fitz

    d_src, d_out = fitz.open(str(src)), fitz.open(str(p))
    assert d_out.page_count == d_src.page_count, "OCR 可搜索 PDF 页数应=原件"
    has_text = False
    for i in range(d_out.page_count):
        assert len(d_out[i].get_images(full=True)) >= 1, f"第{i+1}页缺少页面图像"
        if d_out[i].get_text().strip():
            has_text = True
    assert has_text, "所有页均无文字层——不是可搜索 PDF"
    d_src.close()
    d_out.close()


def test_ocr_text_artifact():
    """OCR 文本产物：非空、可解码（内容打印供人工核对识别质量）。"""
    p = find_artifact("ocr*.txt")
    text = p.read_bytes().decode("utf-8", errors="replace")
    print(f"\nOCR 识别文本（前300字）：{text[:300]!r}")
    assert text.strip(), "OCR 文本产物为空"
