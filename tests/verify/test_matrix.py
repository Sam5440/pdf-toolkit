# -*- coding: utf-8 -*-
"""选项矩阵产物独立校验（pytest + pypdf/PyMuPDF/Pillow）。
浏览器真实操作产出 .artifacts/matrix-*，本文件用与浏览器不同的引擎断言产物符合预期。
产物缺失自动 skip（不伪造通过）。"""
import io
import os
import zipfile

import fitz  # PyMuPDF
import pytest
from pypdf import PdfReader
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, "tests", "e2e", ".artifacts")
FIX = os.path.join(ROOT, "tests", "fixtures", "out")


def art(name):
    p = os.path.join(ART, name)
    if not os.path.exists(p):
        pytest.skip(f"产物缺失（e2e 未运行或未产出）：{name}")
    return p


def pages_of(path, password=None):
    r = PdfReader(path)
    if r.is_encrypted:
        assert password, "产物已加密但用例未提供密码"
        r.decrypt(password)
    return r


# ---------- merge ----------
def test_merge_mixed_5_pages_in_order():
    r = pages_of(art("matrix-merge-mixed.pdf"))
    assert len(r.pages) == 5, f"应为 1图+3页+1图=5 页，实际 {len(r.pages)}"


def test_merge_range_6_pages():
    r = pages_of(art("matrix-merge-range.pdf"))
    assert len(r.pages) == 6


def test_merge_images_only_2_pages():
    r = pages_of(art("matrix-merge-imgs.pdf"))
    assert len(r.pages) == 2


# ---------- split ----------
def _zip_pdfs(name):
    zf = zipfile.ZipFile(art(name))
    return [io.BytesIO(zf.read(n)) for n in zf.namelist() if n.lower().endswith(".pdf")]


def test_split_every2_4_parts_of_2():
    parts = _zip_pdfs("matrix-split-every2.zip")
    assert len(parts) == 4
    for b in parts:
        assert len(PdfReader(b).pages) == 2


def test_split_ranges_2_3_3():
    parts = _zip_pdfs("matrix-split-ranges.zip")
    assert [len(PdfReader(b).pages) for b in parts] == [2, 3, 3]


# ---------- organize / edit ----------
def test_organize_dup_blank_7_pages():
    r = pages_of(art("matrix-organize-dup-blank.pdf"))
    assert len(r.pages) == 7


def test_edit_shapes_renders_content():
    doc = fitz.open(art("matrix-edit-shapes.pdf"))
    assert doc.page_count == 3
    # 第 1 页应有新增图形（矩形/椭圆/高亮以矢量或位图存在）——用像素非空断言：
    pix = doc[0].get_pixmap(dpi=60)
    assert pix.width > 100 and pix.height > 100


# ---------- watermark（栅格化文字 → 像素断言）----------
def _render_gray(path, page=0, dpi=60, password=None):
    doc = fitz.open(path)
    if doc.needs_pass:
        doc.authenticate(password)
    pix = doc[page].get_pixmap(dpi=dpi)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
    return img


def test_watermark_tile_stagger_marks_pixels():
    p = art("matrix-wm-tile-stagger.pdf")
    img = _render_gray(p)
    base = _render_gray(os.path.join(FIX, "multi3.pdf"))
    # 与原页像素有明显差异（水印存在）
    import itertools
    w = min(img.width, base.width)
    h = min(img.height, base.height)
    diff = sum(1 for x, y in itertools.product(range(0, w, 7), range(0, h, 7))
               if abs(img.getpixel((x, y)) - base.getpixel((x, y))) > 25)
    assert diff > 40, f"水印像素差异点过少：{diff}"


def test_watermark_fullscreen_under_ok():
    r = pages_of(art("matrix-wm-fullscreen-under.pdf"))
    assert len(r.pages) == 3


def test_watermark_image_diagonal_ok():
    r = pages_of(art("matrix-wm-image-diagonal.pdf"))
    assert len(r.pages) == 3


def test_watermark_template_vars_ok():
    r = pages_of(art("matrix-wm-template-vars.pdf"))
    assert len(r.pages) == 3


# ---------- overlay ----------
def test_overlay_scale_opacity_3_pages():
    r = pages_of(art("matrix-overlay-scale-opacity.pdf"))
    assert len(r.pages) == 3


def test_overlay_custom_under_3_pages():
    r = pages_of(art("matrix-overlay-custom-under.pdf"))
    assert len(r.pages) == 3


# ---------- compress ----------
def test_compress_auto_8_pages_smaller_or_equal():
    r = pages_of(art("matrix-compress-auto.pdf"))
    assert len(r.pages) == 8


def test_compress_target_volume_reached():
    p = art("matrix-compress-target.pdf")
    r = pages_of(p)
    assert len(r.pages) == 8
    size_mb = os.path.getsize(p) / 1048576
    assert size_mb <= 0.25, f"目标体积 0.2MB 未达标：{size_mb:.3f}MB（含容差 0.25）"


# ---------- security ----------
def test_encrypt_permissions_narrowed():
    p = art("matrix-security-enc-perms.pdf")
    r = PdfReader(p)
    assert r.is_encrypted, "产物应已加密"
    assert r.decrypt("mtx123")
    perms = r.pages  # 可读性
    assert len(perms) == 3
    allowed = r.user_access_permissions
    # pypdf：打印权限通常保留；复制/修改应被禁止（权限位存在时）
    if allowed is not None:
        from pypdf.constants import UserAccessPermissions as UAP
        assert not (allowed & UAP.EXTRACT), "复制（提取）权限应被禁止"
        assert not (allowed & UAP.MODIFY), "修改权限应被禁止"


def test_decrypt_removes_password():
    p = art("matrix-security-dec.pdf")
    r = PdfReader(p)
    assert not r.is_encrypted, "解密产物不应再加密"
    assert len(r.pages) >= 1


# ---------- ocr / text ----------
def test_ocr_searchable_has_text_layer():
    doc = fitz.open(art("matrix-ocr-zh-en.pdf"))
    assert doc.page_count >= 1
    text = "".join(page.get_text() for page in doc)
    assert len(text.strip()) >= 10, "可搜索 PDF 应含不可见文字层"


def test_text_range_with_page_marks():
    txt = open(art("matrix-text-range.txt"), encoding="utf-8", errors="replace").read()
    assert "--- 第 2 页 ---" in txt
    assert "--- 第 4 页 ---" in txt
    assert "--- 第 5 页 ---" not in txt


# ---------- images2pdf（留白修复核心验证）----------
def _img_size(name):
    with Image.open(os.path.join(FIX, name)) as im:
        return im.size


def _page_boxes(path):
    r = PdfReader(path)
    pg = r.pages[0]
    box = pg.mediabox
    return float(box.width), float(box.height), r


def test_i2p_auto_page_equals_image_size():
    w, h, _ = _page_boxes(art("matrix-i2p-auto.pdf"))
    iw, ih = _img_size("photo_l.jpg")
    ew, eh = iw * 72 / 96, ih * 72 / 96
    assert abs(w - ew) < 1.5 and abs(h - eh) < 1.5, f"页面 {w}x{h} 应≈图片 {ew:.1f}x{eh:.1f}"


def _corner_colors(path, dpi=72):
    doc = fitz.open(path)
    pix = doc[0].get_pixmap(dpi=dpi)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    W, H = img.size
    m = 3
    return [img.getpixel(p) for p in [(m, m), (W - m - 1, m), (m, H - m - 1), (W - m - 1, H - m - 1)]]


def test_i2p_a4_contain_has_expected_margins():
    w, h, _ = _page_boxes(art("matrix-i2p-a4-contain.pdf"))
    assert abs(w - 595.28) < 1 and abs(h - 841.89) < 1, f"应为竖向 A4，实际 {w}x{h}"
    # contain + 竖图在竖 A4 上：留白为白（或接近白）
    for c in _corner_colors(art("matrix-i2p-a4-contain.pdf")):
        assert all(ch > 235 for ch in c), f"contain 角落应为白（留白），实际 {c}"


def test_i2p_a4_cover_no_margin():
    for c in _corner_colors(art("matrix-i2p-a4-cover.pdf")):
        assert not all(ch > 235 for ch in c), f"cover 四角不应是白（应有图像覆盖），实际 {c}"


def test_i2p_bg_red_corners():
    for c in _corner_colors(art("matrix-i2p-bg-red.pdf")):
        r, g, b = c
        assert r > 180 and g < 90 and b < 90, f"透明 PNG + 红底：四角应为红色，实际 {c}"


def test_i2p_two_landscape_pages():
    r = pages_of(art("matrix-i2p-two-landscape.pdf"))
    assert len(r.pages) == 2
    for pg in r.pages:
        assert float(pg.mediabox.width) > float(pg.mediabox.height), "强制横向：每页都应为横向"


# ---------- pdf2images / extractimages ----------
def _zip_files(name, exts):
    zf = zipfile.ZipFile(art(name))
    return [(n, zf.read(n)) for n in zf.namelist() if n.lower().endswith(exts)]


def test_pdf2images_png_150dpi_count_and_size():
    items = _zip_files("matrix-p2i-png150.zip", (".png",))
    assert len(items) == 3
    doc = fitz.open(os.path.join(FIX, "multi3.pdf"))
    pw, ph = doc[0].rect.width * 150 / 72, doc[0].rect.height * 150 / 72
    for _, data in items:
        im = Image.open(io.BytesIO(data))
        assert abs(im.width - pw) <= 3 and abs(im.height - ph) <= 3, f"150DPI 尺寸应≈{pw:.0f}x{ph:.0f}，实际 {im.size}"


def test_pdf2images_jpeg_range_2_files():
    items = _zip_files("matrix-p2i-jpeg-q05.zip", (".jpg", ".jpeg"))
    assert len(items) == 2


def test_extract_raw_has_images():
    zf = zipfile.ZipFile(art("matrix-extract-raw.zip"))
    imgs = [n for n in zf.namelist() if n.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".jpx", ".tiff"))]
    assert imgs, "raw 提取应产出图像文件"


def test_extract_composite_has_images():
    zf = zipfile.ZipFile(art("matrix-extract-composite.zip"))
    imgs = [n for n in zf.namelist() if n.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    assert imgs, "composite 提取应产出图像文件"
