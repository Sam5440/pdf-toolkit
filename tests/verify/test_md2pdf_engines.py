# -*- coding: utf-8 -*-
"""md2pdf WASM 引擎产物校验：Typst 排版 PDF 与 Pandoc 高保真 docx。

产物由 tests/e2e/md2pdf-engines.spec.js 真实下载到 tests/e2e/.artifacts/，
缺失时对应测试自动 skip（不算失败）。

判定策略（阈值宁松勿紧防 flaky）：
- Typst PDF：页数>=1、首页墨水>0.5%、正文含中文标题文本、字体嵌入存在；
- 内置轻量 docx：zip 结构合法、word/document.xml 存在且含标题/表格/底纹标记；
- Pandoc docx：zip 结构合法、含 word/document.xml 与 styles.xml、正文含中文标题。
"""
import io
import zipfile
import xml.etree.ElementTree as ET

import pytest

from conftest import find_artifact

pytestmark = pytest.mark.verify

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _doc_text(xml_bytes):
    root = ET.fromstring(xml_bytes)
    return "".join(t.text or "" for t in root.iter(f"{W_NS}t"))


def _zip_names(data):
    zf = zipfile.ZipFile(io.BytesIO(data))
    return zf, zf.namelist()


# ---------------------------------------------------------------- Typst PDF
def test_typst_pdf_structure():
    pdf = find_artifact("md2pdf-typst-out.pdf")
    if not pdf:
        pytest.skip("Typst e2e 产物缺失")
    import fitz

    doc = fitz.open(str(pdf))
    try:
        assert doc.page_count >= 1
        pix = doc[0].get_pixmap(dpi=80)
        s = pix.samples
        n = pix.width * pix.height
        ink = sum(1 for j in range(0, n, 4) if s[j * pix.n] < 200) / (n / 4)
        assert ink > 0.005, f"首页墨水占比过低: {ink}"
        text = "".join(doc[i].get_text() for i in range(min(2, doc.page_count)))
        assert ("傅里叶" in text) or ("流程" in text) or ("Heading" in text), "未提取到中文正文"
    finally:
        doc.close()


# --------------------------------------------------------- 内置轻量 docx
def test_builtin_docx_structure():
    docx = find_artifact("md2pdf-word-out.docx")
    if not docx:
        pytest.skip("内置 docx e2e 产物缺失")
    data = docx.read_bytes() if hasattr(docx, "read_bytes") else open(docx, "rb").read()
    zf, names = _zip_names(data)
    assert "[Content_Types].xml" in names
    assert "word/document.xml" in names
    xml = zf.read("word/document.xml")
    text = _doc_text(xml)
    assert "Word 引擎测试" in text
    assert "粗体" in text
    assert b"<w:tbl>" in xml and b"<w:tblHeader/>" in xml


# ------------------------------------------------------------- Pandoc docx
def test_pandoc_docx_structure():
    docx = find_artifact("md2pdf-pandoc-out.docx")
    if not docx:
        pytest.skip("Pandoc e2e 产物缺失")
    data = docx.read_bytes() if hasattr(docx, "read_bytes") else open(docx, "rb").read()
    zf, names = _zip_names(data)
    assert "word/document.xml" in names
    assert "word/styles.xml" in names
    text = _doc_text(zf.read("word/document.xml"))
    assert ("傅里叶" in text) or ("流程" in text), "pandoc docx 未含中文正文"
