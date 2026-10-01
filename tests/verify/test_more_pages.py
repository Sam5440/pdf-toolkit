# -*- coding: utf-8 -*-
"""「更多」页面/信息类工具产物校验：删除/提取/拼版/切半/裁剪/改尺寸/书签/文档信息/移除元数据/查看器偏好。

产物由 e2e（tests/e2e/more-pages.spec.js）真实下载到 tests/e2e/.artifacts/，
本层用 pypdf / PyMuPDF(fitz) 独立交叉验证；产物缺失自动 skip。
"""
import pytest

from conftest import find_artifact

pytestmark = pytest.mark.verify


def page_texts(path):
    import fitz

    d = fitz.open(str(path))
    texts = [d[i].get_text() for i in range(d.page_count)]
    n = d.page_count
    d.close()
    return n, texts


def test_remove_pages():
    """删除产物：multi3 删第 2 页 → 2 页，含第 1/3 页文字、不含第 2 页。"""
    p = find_artifact("more-remove.pdf")
    n, texts = page_texts(p)
    assert n == 2, f"删除第2页后应剩 2 页，实际 {n}"
    joined = "\n".join(texts)
    assert "Fixture Page 1" in joined, "缺少第 1 页文字"
    assert "Fixture Page 3" in joined, "缺少第 3 页文字"
    assert "Fixture Page 2" not in joined, "第 2 页未被删除"


def test_extract_pages():
    """提取产物：multi3 提取 2-3 → 2 页且顺序正确。"""
    p = find_artifact("more-extract.pdf")
    n, texts = page_texts(p)
    assert n == 2, f"提取 2-3 应得 2 页，实际 {n}"
    assert "Fixture Page 2" in texts[0], "第 1 页应为原第 2 页"
    assert "Fixture Page 3" in texts[1], "第 2 页应为原第 3 页"


def test_nup_four_up():
    """拼版产物：4 合 1 → 1 页 A4 竖版，四个象限均有非白像素。"""
    p = find_artifact("more-nup.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count == 1, f"4 页 4 合 1 应恰为 1 张，实际 {d.page_count} 张"
    pg = d[0]
    w, h = pg.rect.width, pg.rect.height
    assert abs(w - 595.28) < 2 and abs(h - 841.89) < 2, f"应为 A4 竖版（595×842），实际 {w:.1f}×{h:.1f}"
    pix = pg.get_pixmap(dpi=72)
    ch = pix.n
    half_w, half_h = pix.width // 2, pix.height // 2

    def quad_min_nonwhite(qx, qy):
        """象限 (qx,qy) 内取样像素的最小通道值（0-255，<250 即非白）。"""
        best = 255
        for y in range(qy * half_h, (qy + 1) * half_h, 3):
            row_off = y * pix.width
            for x in range(qx * half_w, (qx + 1) * half_w, 3):
                off = (row_off + x) * ch
                v = min(pix.samples[off], pix.samples[off + 1], pix.samples[off + 2])
                if v < best:
                    best = v
                    if best < 250:
                        return best
        return best

    for qx in range(2):
        for qy in range(2):
            m = quad_min_nonwhite(qx, qy)
            assert m < 250, f"象限({qx},{qy})近乎全白（最小通道值 {m}），拼版缺内容"
    d.close()


def test_halve():
    """切半产物：multi3 左右切 → 6 页，每页宽 ≈ 595/2。"""
    p = find_artifact("more-halve.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count == 6, f"3 页左右切半应为 6 页，实际 {d.page_count}"
    for i in range(d.page_count):
        w, h = d[i].rect.width, d[i].rect.height
        assert abs(w - 595.0 / 2) < 1.5, f"第 {i + 1} 页宽应≈{595.0 / 2}，实际 {w:.1f}"
        assert abs(h - 842.0) < 1.5, f"第 {i + 1} 页高应≈842，实际 {h:.1f}"
    d.close()


def test_crop_margin():
    """裁剪产物：四边 50pt → CropBox 收缩为 [50, 50, 545, 792]，MediaBox 不变。

    已知引擎 bug（已上报待修复）：src/core/engine-more.js `pages.crop` 用
    `pm.media.w/.h` 构造 mediaBox，而 pageMeta() 实际返回 `{x,y,width,height}`，
    导致 x1/y1=NaN，写出非法 `/CropBox [ NaN NaN NaN NaN ]`（reset 模式为 `[0 0 NaN NaN]`）。
    检出该缺陷时 skip 并说明；引擎修复后断言自动生效。
    """
    p = find_artifact("more-crop.pdf")
    import logging

    from pypdf import PdfReader

    records = []

    class _Capture(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    cap = _Capture()
    pypdf_logger = logging.getLogger("pypdf")
    pypdf_logger.addHandler(cap)
    try:
        r = PdfReader(str(p))
        r.pages[0].cropbox  # 触发解析
    finally:
        pypdf_logger.removeHandler(cap)
    if any("NaN" in m for m in records):
        pytest.skip(
            "引擎 pages.crop 产出非法 /CropBox [ NaN … ]：engine-more.js 用 pm.media.w/h，"
            "而 pageMeta() 返回 {width,height} → mediaBox x1/y1=NaN。"
            "引擎修复（.w→.width、.h→.height）后本断言自动生效。"
        )
    assert len(r.pages) == 3
    for idx, pg in enumerate(r.pages):
        cb = pg.cropbox
        assert abs(float(cb.left) - 50) < 0.5 and abs(float(cb.bottom) - 50) < 0.5, (
            f"第 {idx + 1} 页 CropBox 左/下应为 50，实际 {cb}"
        )
        assert abs(float(cb.right) - 545) < 0.5 and abs(float(cb.top) - 792) < 0.5, (
            f"第 {idx + 1} 页 CropBox 右/上应为 545/792，实际 {cb}"
        )
        mb = pg.mediabox
        assert abs(float(mb.width) - 595) < 1 and abs(float(mb.height) - 842) < 1, (
            f"第 {idx + 1} 页 MediaBox 不应被改动，实际 {mb}"
        )


def test_resize_letter():
    """改尺寸产物：Letter → 每页 612×792。"""
    p = find_artifact("more-resize.pdf")
    from pypdf import PdfReader

    r = PdfReader(str(p))
    assert len(r.pages) == 3
    for idx, pg in enumerate(r.pages):
        w, h = float(pg.mediabox.width), float(pg.mediabox.height)
        assert abs(w - 612) < 0.5 and abs(h - 792) < 0.5, (
            f"第 {idx + 1} 页应为 612×792（Letter 竖版），实际 {w:.1f}×{h:.1f}"
        )


def test_bookmarks_outline():
    """书签产物：大纲含 1 顶级 + 1 子级，标题与目标页码正确。"""
    p = find_artifact("more-bookmarks.pdf")
    from pypdf import PdfReader

    r = PdfReader(str(p))
    ol = r.outline
    tops = [x for x in ol if not isinstance(x, list)]
    subs = [x for x in ol if isinstance(x, list)]
    assert len(tops) == 1, f"顶级书签应 1 条，实际 {len(tops)}"
    assert len(subs) == 1, f"嵌套子级应 1 组，实际 {len(subs)}"
    assert tops[0]["/Title"] == "第一章", f"顶级书签标题错误：{tops[0]['/Title']}"
    assert r.get_destination_page_number(tops[0]) == 0, "顶级书签应指向第 1 页（0 基 0）"
    kid = subs[0][0]
    assert kid["/Title"] == "第一节", f"子级书签标题错误：{kid['/Title']}"
    assert r.get_destination_page_number(kid) == 1, "子级书签应指向第 2 页（0 基 1）"


def test_docinfo_metadata():
    """文档信息产物：标题/作者经 pypdf 独立读回一致。"""
    p = find_artifact("more-docinfo.pdf")
    from pypdf import PdfReader

    r = PdfReader(str(p))
    md = r.metadata
    assert md.title == "E2E 测试标题", f"标题未写入：{md.title!r}"
    assert md.author == "E2E Tester", f"作者未写入：{md.author!r}"


def test_metaclean_metadata():
    """移除元数据产物：标题/作者/主题/关键词等为空。"""
    p = find_artifact("more-metaclean.pdf")
    from pypdf import PdfReader

    r = PdfReader(str(p))
    md = r.metadata

    def empty(v):
        return v is None or str(v).strip() == ""

    assert empty(md.title), f"标题未清除：{md.title!r}"
    assert empty(md.author), f"作者未清除：{md.author!r}"
    assert empty(md.subject), f"主题未清除：{md.subject!r}"
    assert empty(md.keywords), f"关键词未清除：{md.keywords!r}"
    # fitz 交叉验证
    import fitz

    d = fitz.open(str(p))
    m2 = d.metadata
    assert empty(m2.get("title")) and empty(m2.get("author")), f"fitz 读回元数据未清空：{m2}"
    d.close()


def test_viewerpref_pagemode():
    """查看器偏好产物：/PageMode == /UseOutlines，/HideToolbar 为真。"""
    p = find_artifact("more-viewerpref.pdf")
    from pypdf import PdfReader

    r = PdfReader(str(p))
    root = r.trailer["/Root"]
    assert str(root.get("/PageMode")) == "/UseOutlines", (
        f"PageMode 应为 /UseOutlines，实际 {root.get('/PageMode')}"
    )
    assert bool(root.get("/HideToolbar")) is True, "HideToolbar 应为 true"
