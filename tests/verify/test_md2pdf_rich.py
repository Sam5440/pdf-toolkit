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


def test_md2pdf_rich_code_syntax_colors():
    """内置引擎代码块语法高亮：rich.md 的 ```js 块按 token 着色——
    console(内建 #e36209)/log(函数名 #6f42c1)/字符串(#032f62) 至少一种
    出现在文本层 span 颜色中（整块单色渲染则只有正文黑/灰）。"""
    import fitz

    p = find_artifact("md2pdf-rich-out.pdf")
    doc = fitz.open(str(p))
    try:
        colors = set()
        for page in doc:
            for blk in page.get_text("dict")["blocks"]:
                for line in blk.get("lines", []):
                    for span in line.get("spans", []):
                        colors.add(span["color"])
        hit = {hex(c) for c in (0xE36209, 0x6F42C1, 0x032F62) if c in colors}
        assert hit, f"代码块未按 token 着色（span 颜色集样例：{sorted(hex(c) for c in colors)[:12]}）"
    finally:
        doc.close()


def test_md2pdf_rich_table_gap():
    """表格下边距：底边框→下一文字墨迹顶 ≥ 11pt（GitHub 表格规范 margin-bottom 16px≈12pt
    视觉白隙；旧实现 6pt 时文字墨迹距边框仅 ~2pt，灰底贴死表格）。

    定位：表头「指标」所在单元格矩形出发，沿上下贴合（±2.5pt）的行矩形链走到表格底边，
    再取其下方最近文字块顶——链会在 ~20pt 间隙处断开，不会误吞下方代码块背景条。
    """
    import fitz

    p = find_artifact("md2pdf-rich-out.pdf")
    doc = fitz.open(str(p))
    try:
        page = None
        anchor = None
        for cand in doc:
            hit = next((w for w in cand.get_text("words") if w[4] == "指标"), None)
            if hit:
                page, anchor = cand, hit
                break
        assert anchor, "全文档找不到表头「指标」"
        rects = [d["rect"] for d in page.get_drawings()]
        cur = next(
            (r for r in rects
             if r.x0 <= anchor[0] + 1 and r.x1 >= anchor[2] - 1
             and r.y0 - 2 <= anchor[1] and r.y1 + 2 >= anchor[3]),
            None,
        )
        assert cur, "未找到表头单元格矩形"
        bottom = cur.y1
        while True:
            nxt = [r for r in rects
                   if abs(r.y0 - bottom) <= 2.5 and r.x0 <= anchor[0] + 1 and r.x1 >= anchor[0] + 2]
            if not nxt:
                break
            bottom = max(r.y1 for r in nxt)
        below = [w for w in page.get_text("words") if w[1] >= bottom - 0.5]
        assert below, "表格下方无文字"
        gap = min(w[1] for w in below) - bottom
        assert 11 <= gap <= 45, (
            f"表格底边与下一文字块间距 {gap:.1f}pt（期望 11–45pt；旧实现约 2-6pt）"
        )
    finally:
        doc.close()
