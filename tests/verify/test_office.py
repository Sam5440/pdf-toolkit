# -*- coding: utf-8 -*-
"""Office 近似转换产物校验：可打开、可渲染、页数>0。

诚实说明：浏览器端转换走 DOM→图像→PDF 路径，产物是页面图像，
不一定有文字层——文字断言仅在提取到文字时打印核对，不作硬性要求。
"""
import pytest

from conftest import find_artifact

pytestmark = pytest.mark.verify


def test_office_pdf():
    p = find_artifact("office*.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count >= 1, "Office 转换产物为空"
    all_text = ""
    for i in range(d.page_count):
        d[i].get_pixmap(dpi=50)  # 渲染不崩溃
        all_text += d[i].get_text()
    if all_text.strip():
        print(f"\nOffice 产物含文字层（前200字）：{all_text[:200]!r}")
    else:
        print("\nOffice 产物为纯图像页（DOM→图像路径，符合预期）")
    d.close()


def test_office_pptx_pdf():
    """PPTX 转换产物（若 e2e 单独产出 pptx 命名）。"""
    p = find_artifact("pptx*.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count >= 1
    d.close()
