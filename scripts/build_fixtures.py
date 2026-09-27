#!/usr/bin/env python3
"""合成测试夹具生成器 — 全部素材程序化生成，无用户私有内容。
用法: python3 scripts/build_fixtures.py [输出目录，默认 tests/fixtures/out]
"""
import io
import sys
from pathlib import Path

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "out"


def pdf_bytes(pages=3, text="测试文本", w=595, h=842, rotate=0):
    """中英文混合、矢量图形的标准 PDF"""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w, h))
    for i in range(pages):
        # 背景矩形（矢量）
        c.setFillColorRGB(0.92, 0.95, 1.0)
        c.rect(40, h - 120, w - 80, 60, fill=1, stroke=0)
        c.setFillColorRGB(0.1, 0.1, 0.2)
        c.setFont("Helvetica", 22)
        c.drawString(50, h - 80, f"Fixture Page {i + 1} / EN text")
        # 中文需要 CJK 字体
        try:
            from reportlab.pdfbase import pdfmetrics
            from reportlab.pdfbase.cidfonts import UnicodeCIDFont
            pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
            c.setFont("STSong-Light", 16)
            c.drawString(50, h - 150, f"第 {i + 1} 页：{text}")
        except Exception:
            pass
        c.setFont("Helvetica", 12)
        c.drawString(50, 60, "The quick brown fox jumps over the lazy dog 0123456789")
        c.setStrokeColorRGB(0.3, 0.5, 0.9)
        c.line(50, 100, w - 50, 130)
        if rotate:
            c.showPage()
        else:
            c.showPage()
    c.save()
    return buf.getvalue()


def rotated_pdf():
    """页面自带 /Rotate=90 的 PDF（水印/整理用）"""
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "ROTATED 90 PAGE", fontsize=20)
    doc.xref_set_key(page.xref, "Rotate", "90")
    out = io.BytesIO()
    doc.save(out)
    doc.close()
    return out.getvalue()


def smask_pdf():
    """带 SMask 透明图像的 PDF（压缩/提取用）"""
    import fitz
    from PIL import Image

    img = Image.new("RGBA", (200, 150), (30, 120, 220, 160))
    buf_img = io.BytesIO()
    img.save(buf_img, "PNG")
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_image(fitz.Rect(40, 40, 260, 190), stream=buf_img.getvalue())
    out = io.BytesIO()
    doc.save(out)
    doc.close()
    return out.getvalue()


def scan_pdf(text_simulated=True, pages=2, dpi=150):
    """扫描件模拟：页面只有图像、无文字层（OCR 用）"""
    import fitz
    from PIL import Image, ImageDraw

    doc = fitz.open()
    for i in range(pages):
        im = Image.new("RGB", (int(595 / 72 * dpi), int(842 / 72 * dpi)), "white")
        d = ImageDraw.Draw(im)
        # 渲染文本到位图（模拟扫描）
        from PIL import ImageFont

        try:
            font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 36)
        except Exception:
            font = ImageFont.load_default()
        d.text((60, 80), f"OCR fixture page {i + 1}", fill="black", font=font)
        d.text((60, 160), "Hello OCR World 12345", fill="black", font=font)
        d.text((60, 240), "PDF text recognition test", fill="black", font=font)
        buf_img = io.BytesIO()
        im.save(buf_img, "JPEG", quality=80)
        page = doc.new_page(width=595, height=842)
        page.insert_image(fitz.Rect(0, 0, 595, 842), stream=buf_img.getvalue())
    out = io.BytesIO()
    doc.save(out)
    doc.close()
    return out.getvalue()


def encrypted_pdf(user="user123", owner="owner456", perms=-1):
    """AES-256 加密 PDF（安全工具用）"""
    import fitz

    doc = fitz.open(stream=pdf_bytes(2, "加密前文本"), filetype="pdf")
    out = io.BytesIO()
    doc.save(
        out,
        encryption=fitz.PDF_ENCRYPT_AES_256,
        owner_pw=owner,
        user_pw=user,
        permissions=perms if perms >= 0 else fitz.PDF_PERM_ACCESSIBILITY | fitz.PDF_PERM_PRINT | fitz.PDF_PERM_COPY | fitz.PDF_PERM_ANNOTATE,
    )
    doc.close()
    return out.getvalue()


def big_image_bytes(fmt="JPEG", size=(1200, 900), color=(120, 60, 200)):
    from PIL import Image

    im = Image.new("RGB", size, color)
    buf = io.BytesIO()
    im.save(buf, fmt, quality=85)
    return buf.getvalue()


def alpha_png_bytes():
    from PIL import Image

    im = Image.new("RGBA", (300, 200), (10, 200, 80, 128))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def docx_bytes():
    """结构化 DOCX：标题、段落、表格（Office 工具用）"""
    import docx as docxlib

    d = docxlib.Document()
    d.add_heading("测试文档 DOCX Fixture", level=1)
    d.add_paragraph("This is a paragraph with English text. 下面是中文段落，用于检查字体渲染。")
    t = d.add_table(rows=2, cols=3)
    for r, row in enumerate(t.rows):
        for cidx, cell in enumerate(row.cells):
            cell.text = f"R{r}C{cidx}"
    d.add_page_break()
    d.add_heading("第二页标题", level=2)
    d.add_paragraph("第二页内容，包含足够文字以撑起页面布局。" * 10)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def pptx_bytes():
    """两页 PPTX：标题页 + 内容页"""
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[0])
    s1.shapes.title.text = "PPTX Fixture 标题页"
    s1.placeholders[1].text = "副标题 subtitle"
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = "第二页 Content"
    body = s2.placeholders[1].text_frame
    body.text = "要点一 bullet one"
    p = body.add_paragraph()
    p.text = "要点二 bullet two 中文"
    p.font.size = Pt(24)
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def truncated_pdf():
    """截断损坏的 PDF（错误处理用）"""
    return pdf_bytes(2)[: 4096 // 2] + b"%%EOF"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    files = {
        "multi3.pdf": pdf_bytes(3, "示例文档"),
        "multi8.pdf": pdf_bytes(8, "长文档拆分"),
        "rotated90.pdf": rotated_pdf(),
        "smask_alpha.pdf": smask_pdf(),
        "scan2.pdf": scan_pdf(),
        "enc_user123.pdf": encrypted_pdf(),
        "photo_l.jpg": big_image_bytes("JPEG", (1200, 900)),
        "photo_p.jpg": big_image_bytes("JPEG", (900, 1200), (200, 120, 40)),
        "alpha.png": alpha_png_bytes(),
        "doc.docx": docx_bytes(),
        "slides.pptx": pptx_bytes(),
        "corrupted.pdf": truncated_pdf(),
    }
    for name, data in files.items():
        (OUT / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes")
    print(f"\n夹具输出目录: {OUT}")


if __name__ == "__main__":
    main()
