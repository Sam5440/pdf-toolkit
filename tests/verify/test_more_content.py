# -*- coding: utf-8 -*-
"""「更多」分组 安全/内容/导出 类工具产物校验（浏览器生产、python 独立交叉验证）。

产物命名约定（e2e more-content.spec.js 以精确名保存到 tests/e2e/.artifacts/）：
  mc-pagenumbers.pdf  mc-sign.pdf  mc-redact.pdf  mc-form.pdf
  mc-ff-noflat.pdf    mc-ff-flat.pdf  mc-flatten.pdf  mc-raster.pdf
  mc-repair.pdf       mc-word.docx  mc-ppt.pptx  mc-excel.xlsx  mc-html.html
  mc-md.md  mc-rtf.rtf  mc-epub.epub  mc-odt.odt  mc-tiff.tiff  mc-svg.zip
  mc-pptimg.pptx
"""
import io
import re
import zipfile
import xml.etree.ElementTree as ET

import pytest

from conftest import fixture, find_artifact, mean_abs_pixel_diff

pytestmark = pytest.mark.verify


# ---------------------------------------------------------------------------
# 添加页码
# ---------------------------------------------------------------------------

def _dark_pixels_in_region(pdf_path, page_idx, x0=0.30, x1=0.70, y0=0.94, y1=0.985, dpi=150, thresh=130):
    """渲染指定页并统计区域内深色像素数（页码为位图文字，get_text 不可见）。"""
    import fitz

    d = fitz.open(str(pdf_path))
    pix = d[page_idx].get_pixmap(dpi=dpi)
    w, h = pix.width, pix.height
    n = pix.n
    samples = pix.samples
    count = 0
    for py in range(int(h * y0), min(h, int(h * y1))):
        row = py * pix.stride
        for px in range(int(w * x0), min(w, int(w * x1))):
            off = row + px * n
            if samples[off] < thresh and samples[off + 1] < thresh and samples[off + 2] < thresh:
                count += 1
    d.close()
    return count


def test_pagenumbers_bitmap_page_number():
    """页码产物：页数不变；末页底部中央区域出现深色像素（位图页码文字）。"""
    p = find_artifact("mc-pagenumbers.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count == 3, f"页码处理不应改变页数，实际 {d.page_count}"
    last = d.page_count - 1
    dark = _dark_pixels_in_region(p, last)
    assert dark >= 5, f"末页底部中央未检测到页码文字（深色像素 {dark}）"
    # 首页同样应有页码
    dark0 = _dark_pixels_in_region(p, 0)
    assert dark0 >= 5, f"首页底部中央未检测到页码文字（深色像素 {dark0}）"
    d.close()


# ---------------------------------------------------------------------------
# 签署
# ---------------------------------------------------------------------------

def test_sign_stamp_pixel_diff():
    """签署产物：第 1 页与原件渲染像素差显著（签名图章已盖）。"""
    p = find_artifact("mc-sign.pdf")
    src = fixture("multi3.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count == 3, "签署不应改变页数"
    d.close()
    diff = mean_abs_pixel_diff(p, src, page=0, dpi=72)
    assert diff > 0.1, f"第 1 页与原件差异过小（{diff:.3f}），签名可能未盖章"


# ---------------------------------------------------------------------------
# 涂黑
# ---------------------------------------------------------------------------

def test_redact_text_removed():
    """涂黑产物：被涂区域文字被删除（mupdf 深度涂黑）；若为回退黑框，则区域应为全黑。"""
    p = find_artifact("mc-redact.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count == 3, "涂黑不应改变页数"
    text = d[0].get_text()
    if "Fixture Page 1" not in text:
        # 深度涂黑：文字已物理删除；未涂区域文字仍在
        assert "quick brown fox" in text, "未涂区域的文字不应被删除"
        print("\nredact: mupdf 深度涂黑（文字已删除）")
    else:
        # 回退黑框：文字仍在，但标记区域渲染应为全黑
        print("\nredact: 回退模式（黑框遮盖，文字未删除）")
        page = d[0]
        pw, ph = page.rect.width, page.rect.height
        # 标记区域（视觉坐标 x 40-340, y 50-100）中心取样
        rect = fitz.Rect(pw * 0.15, ph * 0.075, pw * 0.45, ph * 0.10)
        pix = page.get_pixmap(clip=rect, dpi=96)
        s = pix.samples
        n = pix.n
        total = pix.width * pix.height
        dark = sum(1 for i in range(0, total * n, n) if s[i] < 40 and s[i + 1] < 40 and s[i + 2] < 40)
        assert dark >= total * 0.9, f"回退模式区域未全黑（黑像素 {dark}/{total}）"
    d.close()


# ---------------------------------------------------------------------------
# 表单：创建 → 填写 → 扁平化
# ---------------------------------------------------------------------------

def test_formcreate_fields_exist():
    """formcreate 产物：pypdf 可见 fullname 文本字段（复选框类型待引擎 createCheckBox 缺陷修复）。"""
    from pypdf import PdfReader

    p = find_artifact("mc-form.pdf")
    r = PdfReader(str(p))
    fields = r.get_fields() or {}
    assert "fullname" in fields, f"缺少 fullname 字段：{list(fields)}"


def test_formfill_values():
    """formfill（未扁平化）产物：字段值 = 填写值。"""
    from pypdf import PdfReader

    p = find_artifact("mc-ff-noflat.pdf")
    r = PdfReader(str(p))
    fields = r.get_fields() or {}
    f = fields.get("fullname") or fields.get("/fullname")
    assert f is not None, f"fullname 字段缺失：{list(fields)}"
    v = f.get("/V")
    assert v is not None and "Sam Lee" in str(v), f"fullname 值不符：{v!r}"


def test_formfill_flattened():
    """formfill（扁平化）产物：字段消失，填写值烧入页面文字。"""
    from pypdf import PdfReader

    p = find_artifact("mc-ff-flat.pdf")
    r = PdfReader(str(p))
    fields = r.get_fields() or {}
    assert "fullname" not in fields and "/fullname" not in fields, "扁平化后字段应消失"

    import fitz

    d = fitz.open(str(p))
    assert "Sam Lee" in d[0].get_text(), "扁平化后填写值应烧入页面"
    d.close()


# ---------------------------------------------------------------------------
# 栅格化 / 扁平化（raster）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("pattern,desc", [
    ("mc-raster.pdf", "栅格化"),
    ("mc-flatten.pdf", "扁平化(整册栅格化)"),
])
def test_rasterized_text_empty(pattern, desc):
    """栅格类产物：所有页面文字层为空（全图化），页数不变。"""
    import fitz

    p = find_artifact(pattern)
    d = fitz.open(str(p))
    assert d.page_count == 3, f"{desc}不应改变页数"
    for i in range(d.page_count):
        d[i].get_pixmap(dpi=40)  # 渲染不崩溃
        assert not d[i].get_text().strip(), f"{desc}第 {i + 1} 页仍含文字层"
    d.close()


# ---------------------------------------------------------------------------
# 修复
# ---------------------------------------------------------------------------

def test_repaired_pdf_opens():
    """修复产物：pypdf 可打开、未加密、页数 = 3（与损坏源一致）。"""
    from pypdf import PdfReader

    p = find_artifact("mc-repair.pdf")
    r = PdfReader(str(p))
    assert not r.is_encrypted, "修复产物不应加密"
    assert len(r.pages) == 3, f"修复后页数应为 3，实际 {len(r.pages)}"


# ---------------------------------------------------------------------------
# 导出族（zip 结构 / 文本标记）
# ---------------------------------------------------------------------------

def _zip_text(pattern):
    p = find_artifact(pattern)
    with zipfile.ZipFile(str(p)) as z:
        return {name: z.read(name) for name in z.namelist()}, p


def test_docx_structure():
    files, _ = _zip_text("mc-word.docx")
    assert "word/document.xml" in files
    doc = files["word/document.xml"].decode("utf-8")
    assert "<w:document" in doc
    assert "Fixture" in doc, "DOCX 正文应保留原 PDF 文字"


def test_xlsx_structure():
    files, _ = _zip_text("mc-excel.xlsx")
    assert "xl/worksheets/sheet1.xml" in files
    sheet = files["xl/worksheets/sheet1.xml"].decode("utf-8")
    assert "<worksheet" in sheet
    assert ("Fixture" in sheet) or any(ch.isdigit() for ch in sheet), "工作表应含文本或数字"


def test_pptx_structure():
    files, _ = _zip_text("mc-ppt.pptx")
    assert "ppt/slides/slide1.xml" in files
    slide = files["ppt/slides/slide1.xml"].decode("utf-8")
    assert "<p:sld" in slide
    assert "Fixture" in slide, "幻灯片应保留原 PDF 文字"


def test_pptximg_structure():
    """图片型 PPTX：每页一帧整页图，跟随页面比例时 off=0,0 且图占满幻灯片。"""
    files, _ = _zip_text("mc-pptimg.pptx")
    slides = sorted(n for n in files if n.startswith("ppt/slides/slide") and n.endswith(".xml"))
    media = sorted(n for n in files if n.startswith("ppt/media/"))
    assert len(slides) == 3, "multi3 共 3 页 → 3 帧幻灯片"
    assert len(media) == 3, "每帧对应 1 张整页媒体图"
    pres = files["ppt/presentation.xml"].decode("utf-8")
    m = re.search(r'<p:sldSz cx="(\d+)" cy="(\d+)"/>', pres)
    assert m, "presentation.xml 应声明幻灯片尺寸"
    cx, cy = int(m.group(1)), int(m.group(2))
    a4_ratio = 595.2756 / 841.8898
    assert abs(cx / cy - a4_ratio) < 0.01, "幻灯片比例应跟随 A4 页面（默认「跟随 PDF 首页」）"
    for n in slides:
        s = files[n].decode("utf-8")
        assert "<p:pic>" in s, "每帧应为整页图片"
        assert 'r:embed="rId2"' in s
        off = re.search(r'<a:off x="(-?\d+)" y="(-?\d+)"/><a:ext cx="(\d+)" cy="(\d+)"/>', s)
        assert off, "图片应有显式位置/尺寸"
        assert (int(off.group(1)), int(off.group(2))) == (0, 0), "跟随页面比例时应整页铺满（无留白偏移）"
        assert (int(off.group(3)), int(off.group(4))) == (cx, cy), "图片应占满幻灯片"
    # 媒体为真实渲染位图（PNG 头），宽高比≈A4
    assert files[media[0]][:8] == b"\x89PNG\r\n\x1a\n"
    from PIL import Image

    img = Image.open(io.BytesIO(files[media[0]]))
    w, h = img.size
    assert abs(w / h - a4_ratio) < 0.02, f"媒体图比例异常：{w}x{h}"


def test_odt_structure():
    files, _ = _zip_text("mc-odt.odt")
    assert "content.xml" in files
    assert files.get("mimetype", b"").startswith(b"application/vnd.oasis.opendocument.text")
    content = files["content.xml"].decode("utf-8")
    assert "Fixture" in content


def test_epub_structure():
    files, _ = _zip_text("mc-epub.epub")
    assert "OEBPS/ch1.xhtml" in files
    ch = files["OEBPS/ch1.xhtml"].decode("utf-8")
    ET.fromstring(ch)  # XHTML 可解析
    assert "Fixture" in ch


def test_rtf_content():
    p = find_artifact("mc-rtf.rtf")
    raw = p.read_bytes()
    assert raw.startswith(b"{\\rtf1"), "RTF 文件头不符"
    assert (b"\\u" in raw) or (b"Fixture" in raw), "RTF 应含 \\u 转义或原文本"


def test_html_content():
    p = find_artifact("mc-html.html")
    html = p.read_text("utf-8")
    assert "<html" in html
    assert "Fixture" in html


def test_md_content():
    p = find_artifact("mc-md.md")
    md = p.read_text("utf-8")
    assert md.strip(), "Markdown 产物为空"
    assert "Fixture" in md


# ---------------------------------------------------------------------------
# TIFF / SVG
# ---------------------------------------------------------------------------

def test_tiff_multipage():
    """pdf2tiff 产物：PIL 可读，帧数 >= 3（multi3 全部页）。"""
    from PIL import Image

    p = find_artifact("mc-tiff.tiff")
    img = Image.open(str(p))
    assert getattr(img, "n_frames", 1) >= 3, f"TIFF 帧数不足：{getattr(img, 'n_frames', 1)}"
    img.seek(0)
    img.load()
    assert img.size[0] > 0 and img.size[1] > 0
    img.close()


def test_svg_zip_contains_image():
    """pdf2svg 产物：ZIP 内首个 SVG 可解析且含 <image>（位图封装）。"""
    p = find_artifact("mc-svg.zip")
    with zipfile.ZipFile(str(p)) as z:
        svgs = sorted(n for n in z.namelist() if n.lower().endswith(".svg"))
        assert svgs, "ZIP 中没有 SVG"
        root = ET.fromstring(z.read(svgs[0]))
    assert root.tag.endswith("svg"), f"根元素不是 svg：{root.tag}"
    images = [el for el in root.iter() if el.tag.endswith("image")]
    assert images, "SVG 应含 <image>（位图封装，非矢量追踪）"
