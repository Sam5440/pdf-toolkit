# -*- coding: utf-8 -*-
"""「更多 / 创建 PDF」产物校验：位图页面非空白、QR 内容读回、格式转换产物、TIFF 页数。

产物由 tests/e2e/more-create.spec.js 真实下载到 tests/e2e/.artifacts/，
缺失时对应测试自动 skip（不算失败）。
"""
import pytest

from conftest import fixture, find_artifact

pytestmark = pytest.mark.verify

QR_CONTENT = "https://example.com/pdftoolkit-fixture"


def _assert_bitmap_pdf(path, min_pages=1, note=""):
    """打开 PDF：页数达标 + 至少一页抽样像素非全白（text.toPdf 产物为位图页面）。"""
    import fitz

    doc = fitz.open(str(path))
    try:
        assert doc.page_count >= min_pages, f"页数不足：{doc.page_count} < {min_pages} {note}"
        has_ink = False
        for i in range(doc.page_count):
            pix = doc[i].get_pixmap(dpi=60)
            s = pix.samples
            step = max(1, len(s) // 6000)
            dark = sum(1 for j in range(0, len(s), step) if s[j] < 245)
            if dark > 10:
                has_ink = True
                break
        assert has_ink, f"所有页面渲染为空白——内容未被绘制 {note}"
    finally:
        doc.close()


def test_createpdf_pdf():
    _assert_bitmap_pdf(find_artifact("createpdf-out.pdf"))


def test_txtpdf_pdf():
    _assert_bitmap_pdf(find_artifact("txtpdf-out.pdf"))


def test_txtpdf_csv_pdf():
    _assert_bitmap_pdf(find_artifact("txtpdf-csv-out.pdf"))


def test_md2pdf_pdf():
    _assert_bitmap_pdf(find_artifact("md2pdf-out.pdf"))


def test_rtf2pdf_pdf():
    _assert_bitmap_pdf(find_artifact("rtf2pdf-out.pdf"))


def test_epub2pdf_pdf():
    """EPUB 两章节：至少 1 页（章节间有 pagebreak，多页也合法）+ 非空白。"""
    _assert_bitmap_pdf(find_artifact("epub2pdf-out.pdf"), min_pages=1)


def test_odf2pdf_pdf():
    _assert_bitmap_pdf(find_artifact("odf2pdf-out.pdf"))


def test_excelpdf_pdf():
    _assert_bitmap_pdf(find_artifact("excelpdf-out.pdf"))


def test_svgpdf_pdf():
    _assert_bitmap_pdf(find_artifact("svgpdf-out.pdf"))


def test_webpage_pdf():
    _assert_bitmap_pdf(find_artifact("webpage-out.pdf"))


def test_scan_pdf():
    _assert_bitmap_pdf(find_artifact("scan-out.pdf"))


def test_invoice_pdf():
    _assert_bitmap_pdf(find_artifact("invoice-out.pdf"))


def test_tiffpdf_pages():
    """TIFF 转 PDF：两页 TIFF → pypdf 页数=2。"""
    from pypdf import PdfReader

    r = PdfReader(str(find_artifact("tiffpdf-out.pdf")))
    assert len(r.pages) == 2, f"tiffpdf 产物页数应=2，实际 {len(r.pages)}"


def test_qrcode_roundtrip():
    """二维码 PNG：cv2.QRCodeDetector 读回内容与输入一致。"""
    cv2 = pytest.importorskip("cv2")
    import numpy as np

    p = find_artifact("qrcode-out.png")
    img = cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_COLOR)
    assert img is not None, "二维码 PNG 无法解码"
    det = cv2.QRCodeDetector()
    text, _, _ = det.detectAndDecode(img)
    assert text == QR_CONTENT, f"二维码读回内容不一致：{text!r} != {QR_CONTENT!r}"


def test_webpconvert_jpeg():
    from PIL import Image

    p = find_artifact("webpconvert-out.jpg")
    with Image.open(p) as im:
        assert im.format == "JPEG", f"格式应为 JPEG，实际 {im.format}"
        with Image.open(fixture("photo.webp")) as src:
            assert im.size == src.size, f"尺寸不一致：{im.size} != {src.size}"


def test_webpconvert_png():
    from PIL import Image

    p = find_artifact("webpconvert-out.png")
    with Image.open(p) as im:
        assert im.format == "PNG", f"格式应为 PNG，实际 {im.format}"
        with Image.open(fixture("photo.webp")) as src:
            assert im.size == src.size, f"尺寸不一致：{im.size} != {src.size}"
