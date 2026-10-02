# -*- coding: utf-8 -*-
"""text.toPdf 文本型产物校验：真实文字（可搜索）+ NotoSansSC 内嵌字体。

产物来源（e2e 真实下载到 tests/e2e/.artifacts/，缺失自动 skip）：
- txtpdf-out.pdf / createpdf-out.pdf ← tests/e2e/more-create.spec.js
  （createpdf 内容见该 spec 的 textarea 填充；sample.txt 夹具见 scripts/build_fixtures.py）
- md2pdf-vector-out.pdf ← tests/e2e/md2pdf-vector.spec.js

判定：PyMuPDF get_text 必须抽取到源文本关键串（正文以嵌入字体真实绘制）；
page.get_fonts() 存在内嵌（ext != 'n/a'）的 NotoSansSC 条目（subset:false 嵌入的
fontTools 预子集字库，postscript 名含 NotoSansSC）。
"""
import pytest

from conftest import find_artifact

pytestmark = pytest.mark.verify


def _pages_and_text(path):
    import fitz

    doc = fitz.open(str(path))
    try:
        return doc.page_count, "".join(page.get_text() for page in doc)
    finally:
        doc.close()


def _assert_embedded_noto(path):
    """字体表中存在内嵌 NotoSansSC 条目（ext == 'n/a' 表示未内嵌）。"""
    import fitz

    doc = fitz.open(str(path))
    try:
        fonts = []
        for page in doc:
            fonts.extend(page.get_fonts(full=True))
        embedded_noto = [f for f in fonts if "NotoSansSC" in str(f[3]) and f[1] != "n/a"]
        assert embedded_noto, f"未发现内嵌 NotoSansSC 字体：{fonts}"
    finally:
        doc.close()


def test_txtpdf_text_layer():
    """txtpdf 产物正文可搜索（源：tests/fixtures/out/sample.txt）。"""
    p = find_artifact("txtpdf-out.pdf")
    pages, text = _pages_and_text(p)
    assert pages >= 1, f"页数不足：{pages}"
    for needle in ("工具箱示例文本", "Fixture", "第二段", "0123456789"):
        assert needle in text, f"文本层缺少「{needle}」——正文未以真实文字绘制"
    _assert_embedded_noto(p)


def test_createpdf_text_layer():
    """createpdf 产物正文可搜索（e2e 撰写：项目周报标题/列表/表格/引用/代码块）。"""
    p = find_artifact("createpdf-out.pdf")
    pages, text = _pages_and_text(p)
    assert pages >= 1, f"页数不足：{pages}"
    for needle in ("项目周报", "待办一", "全程本地处理", "console.log"):
        assert needle in text, f"文本层缺少「{needle}」——正文未以真实文字绘制"
    _assert_embedded_noto(p)


def test_md2pdf_vector_text_layer():
    """md2pdf 文本型产物（md2pdf-vector-out.pdf）：标题可搜索 + 内嵌字体。"""
    p = find_artifact("md2pdf-vector-out.pdf")
    pages, text = _pages_and_text(p)
    assert pages >= 1, f"页数不足：{pages}"
    assert "傅里叶与流程" in text, "文本层缺少标题「傅里叶与流程」——正文未以真实文字绘制"
    _assert_embedded_noto(p)
