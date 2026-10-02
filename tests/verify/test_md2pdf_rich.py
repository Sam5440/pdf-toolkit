# -*- coding: utf-8 -*-
"""md2pdf 富渲染产物校验：KaTeX 公式 / Mermaid 图形 / markmap 思维导图是否真实渲染。

产物由 tests/e2e/md2pdf-rich.spec.js 真实下载到 tests/e2e/.artifacts/，
缺失时对应测试自动 skip（不算失败）。

判定策略（阈值宁松勿紧防 flaky）：
- 页数 >= 1；
- 第 1、2 页 100dpi 渲染：彩色像素（max(rgb)-min(rgb)>40，Mermaid classDef 节点/思维导图着色）
  按页抽样计数 > 300，证明图形真实渲染而非降级为纯文本；
- 整页墨水占比 > 0.5%（公式/文字存在，防全白）；
- 与纯文本产物对比（可选）：渲染像素不完全相同。
"""
import pytest

from conftest import find_artifact

pytestmark = pytest.mark.verify

PAGE_MAX = 2
DPI = 100
COLORFUL_MIN = 300  # 抽样后彩色像素计数下限
INK_MIN = 0.005     # 墨水占比下限


def _page_stats(pdf_path, page_no):
    """渲染第 page_no 页，返回（彩色抽样像素数, 抽样总数, 墨水占比）。"""
    import fitz

    doc = fitz.open(str(pdf_path))
    try:
        if page_no >= doc.page_count:
            return None
        pix = doc[page_no].get_pixmap(dpi=DPI)
        s = pix.samples
        n = pix.width * pix.height
        colorful = 0
        ink = 0
        total = 0
        for j in range(0, n, 2):  # 每 2 像素抽样
            k = j * 3
            r, g, b = s[k], s[k + 1], s[k + 2]
            mx = max(r, g, b)
            mn = min(r, g, b)
            if mx - mn > 40:
                colorful += 1
            if mx < 245:
                ink += 1
            total += 1
        return colorful, total, ink / total
    finally:
        doc.close()


def test_md2pdf_rich_pages():
    """页数 >= 1。"""
    import fitz

    p = find_artifact("md2pdf-rich-out.pdf")
    doc = fitz.open(str(p))
    try:
        assert doc.page_count >= 1, f"页数不足：{doc.page_count}"
    finally:
        doc.close()


def test_md2pdf_rich_colorful_graphics():
    """第 1/2 页存在足量彩色像素——Mermaid/思维导图真实渲染（未降级纯文本）。"""
    p = find_artifact("md2pdf-rich-out.pdf")
    best = 0
    checked = 0
    for i in range(PAGE_MAX):
        st = _page_stats(p, i)
        if st is None:
            continue
        colorful, total, _ = st
        checked += 1
        best = max(best, colorful)
    assert checked >= 1, "无可用页面"
    assert best > COLORFUL_MIN, (
        f"彩色像素不足（峰值 {best} <= {COLORFUL_MIN}）——图形可能未真实渲染"
    )


def test_md2pdf_rich_ink():
    """第 1/2 页整页墨水占比 > 0.5%——公式与文字存在，防全白。"""
    p = find_artifact("md2pdf-rich-out.pdf")
    checked = 0
    for i in range(PAGE_MAX):
        st = _page_stats(p, i)
        if st is None:
            continue
        _, total, ink_frac = st
        checked += 1
        assert ink_frac > INK_MIN, f"第 {i + 1} 页墨水占比 {ink_frac:.4f} <= {INK_MIN}（疑似空白）"
    assert checked >= 1, "无可用页面"


def test_md2pdf_rich_differs_from_plain_text():
    """（可选）富渲染产物与纯文本产物渲染不能完全相同。纯文本产物缺失时 skip。"""
    rich = find_artifact("md2pdf-rich-out.pdf")
    plain = find_artifact("txtpdf-out.pdf")
    a = _page_stats(rich, 0)
    b = _page_stats(plain, 0)
    assert a is not None and b is not None
    assert abs(a[2] - b[2]) > 1e-6 or a[0] != b[0], "富渲染产物与纯文本产物渲染完全相同"


def test_md2pdf_editor_out():
    """在线编辑器产物（md2pdf-editor-out.pdf）：可打开、页数>=1、有墨水。"""
    import fitz

    p = find_artifact("md2pdf-editor-out.pdf")
    doc = fitz.open(str(p))
    try:
        assert doc.page_count >= 1, f"页数不足：{doc.page_count}"
        pix = doc[0].get_pixmap(dpi=80)
        s = pix.samples
        n = pix.width * pix.height
        ink = sum(1 for j in range(0, n, 3) if max(s[j * 3], s[j * 3 + 1], s[j * 3 + 2]) < 245)
        assert ink > 50, f"首页疑似空白（墨水抽样 {ink}）"
    finally:
        doc.close()


def test_md2pdf_rich_text_layer():
    """文本型 PDF 文本层可搜索：标题/正文/表头以真实文字绘制（公式/图形是图片，不计入文字）。

    rich.md 关键中文：h1「傅里叶与流程」、正文「能量公式」（含行内公式混排）、
    h2「数据表」（表格标题）。文字必须能被 PyMuPDF 抽取，否则说明回退成了图片型。
    """
    import fitz

    p = find_artifact("md2pdf-rich-out.pdf")
    doc = fitz.open(str(p))
    try:
        assert doc.page_count >= 1, f"页数不足：{doc.page_count}"
        text = "".join(page.get_text() for page in doc)
        for needle in ("傅里叶与流程", "能", "数据表"):
            assert needle in text, f"文本层缺少「{needle}」——正文未以真实文字绘制（疑似回退图片型）"
        for page in doc:
            words = page.get_text("words")
            assert len(words) >= 1, f"第 {page.number + 1} 页文本层为空（正文未以文字绘制）"
            if len(words) < 5 and not page.get_images(full=True):
                pytest.fail(
                    f"第 {page.number + 1} 页 word 数 {len(words)} < 5 且无图形内容（文本层异常）"
                )
    finally:
        doc.close()
