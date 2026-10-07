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


def whiteborder_pdf():
    """两页纯白边距 A4（页面剪裁工具用）：第 1 页边距 L60/T72/R84/B96，第 2 页 L30/T40/R50/B60。

    内容矩形精确落在边距框上（无额外内缩），可视化检测应还原出这些边距值。
    """
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(595, 842))
    specs = [(60, 72, 84, 96), (30, 40, 50, 60)]  # 视觉 左/上/右/下 pt
    for (l, t, r, b) in specs:
        x0, x1 = l, 595 - r
        y0, y1 = b, 842 - t  # reportlab y 轴向上
        c.setFillColorRGB(0.55, 0.65, 0.95)
        c.rect(x0, y0, x1 - x0, y1 - y0, fill=1, stroke=0)
        c.setFillColorRGB(0.05, 0.05, 0.1)
        c.setFont("Helvetica", 20)
        c.drawCentredString((x0 + x1) / 2, (y0 + y1) / 2, f"MARGIN {l}/{t}/{r}/{b}")
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


def downscaled_img_pdf():
    """超大图像绘制到极小区域（渲染时 >2 倍降采样，走 pdf.js 临时 canvas 缩放路径）"""
    import fitz
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1600, 1600), (245, 245, 245))
    d = ImageDraw.Draw(img)
    for i in range(0, 1600, 40):
        d.line([(0, i), (1600, i)], fill=(120, 160, 220))
        d.line([(i, 0), (i, 1600)], fill=(220, 160, 120))
    buf_img = io.BytesIO()
    img.save(buf_img, "JPEG", quality=85)
    doc = fitz.open()
    page = doc.new_page(width=400, height=300)
    page.insert_image(fitz.Rect(30, 30, 120, 120), stream=buf_img.getvalue())
    page.insert_text((200, 100), "DOWNSCALED IMAGE", fontsize=14)
    out = io.BytesIO()
    doc.save(out)
    doc.close()
    return out.getvalue()


def tiling_pattern_pdf():
    """TilingPattern 平铺图案 PDF（reportlab 不支持，手工构造原始对象；
    渲染走 pdf.js 临时 canvas 图案路径）"""
    tile = b"0.8 0 0 RG 1 w 0 0 m 16 16 l S 16 0 m 0 16 l S 1 0 0 RG 8 8 5 0 360 arc f"
    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] "
           b"/Resources << /Pattern << /P1 4 0 R >> >> /Contents 5 0 R >>",
        4: b"<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 "
           b"/BBox [0 0 16 16] /XStep 16 /YStep 16 /Resources << >> /Length "
           + str(len(tile)).encode() + b" >>\nstream\n" + tile + b"\nendstream",
        5: b"<< /Length 40 >>\nstream\nq /Pattern cs /P1 scn 0 0 300 200 re f Q\nendstream",
    }
    buf = io.BytesIO()
    buf.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for num in sorted(objs):
        offsets[num] = buf.tell()
        buf.write(str(num).encode() + b" 0 obj\n" + objs[num] + b"\nendobj\n")
    xref = buf.tell()
    buf.write(b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n")
    for num in sorted(objs):
        buf.write(("%010d 00000 n \n" % offsets[num]).encode())
    buf.write(b"trailer\n<< /Size " + str(len(objs) + 1).encode()
              + b" /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n")
    return buf.getvalue()


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


# ---------------------------------------------------------------------------
# 「更多 / 创建 PDF」簇夹具（txt/md/csv/rtf/epub/odf/xlsx/html/svg/webp/tiff/heic）
# ---------------------------------------------------------------------------

def text_file_bytes():
    """多行 txt：中英文混合 + 制表符（文本转 PDF 用）"""
    lines = [
        "PDF 工具箱示例文本 Fixture",
        "The quick brown fox jumps over the lazy dog.",
        "",
        "第二段：全部处理在浏览器内完成，文件不会上传服务器。",
        "缩进\t制表符\t测试",
        "END OF LINE 0123456789",
    ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def log_file_bytes():
    """多行 log（文本转 PDF 用）"""
    lines = [
        "2026-01-01 09:00:00 INFO  service started",
        "2026-01-01 09:00:01 INFO  加载配置完成",
        "2026-01-01 09:00:05 WARN  磁盘余量不足 10%",
        "2026-01-01 09:01:00 ERROR sample log fixture line",
        "2026-01-01 09:02:00 INFO  shutdown",
    ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def csv_file_bytes():
    """带引号转义的 CSV（表格块解析用）"""
    rows = [
        "名称,数量,单价,备注",
        '"键盘, 机械",2,"199.00","带""质检""标签"',
        "鼠标,3,49.5,无线 2.4G",
        "显示器,1,1299.00,27 英寸",
    ]
    return ("\n".join(rows) + "\n").encode("utf-8")


def md_file_bytes():
    """Markdown 子集：标题/列表/粗体/表格/代码/引用/分隔线"""
    text = """# 项目说明

这是一个 **Markdown** 测试文档，包含 `inline code` 与 [链接](https://example.com)。

## 功能列表

- 标题与段落
- **粗体** 与 *斜体*
- 表格与代码块

1. 第一项
2. 第二项

> 引用：全部处理在本地浏览器完成，隐私安全。

| 工具 | 状态 |
| --- | --- |
| 合并 | 可用 |
| 拆分 | 可用 |

---

```js
console.log("hello fixture");
```

### 结尾
文档到此结束。
"""
    return text.encode("utf-8")


def rtf_file_bytes():
    """RTF 子集：\\uN 中文、\\'hh 字节、\\par 分段、fonttbl 目的组"""
    return (
        "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\n"
        "\\f0\\fs24 \\u26379?\\u21451?\\'20rtf fixture\\par\n"
        "Hello \\'41\\'42\\'43 123\\par\n"
        "\\u20013?\\u22269?\\u25991? test line\\par\n"
        "}\n"
    ).encode("utf-8")


def _zip_files(entries):
    """entries: {path: bytes|str} → zip 字节（mimetype 若存在则首位无压缩存储）"""
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        if "mimetype" in entries:
            z.writestr(
                zipfile.ZipInfo("mimetype"), entries["mimetype"],
                compress_type=zipfile.ZIP_STORED,
            )
        for p, data in entries.items():
            if p == "mimetype":
                continue
            z.writestr(p, data)
    return buf.getvalue()


def epub_bytes():
    """最小 EPUB（container.xml + OPF + 两个 XHTML 章节）"""
    container = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
        "</container>\n"
    )
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        "    <dc:title>测试电子书 Fixture</dc:title>\n"
        "    <dc:creator>PDF Toolkit</dc:creator>\n"
        "  </metadata>\n"
        "  <manifest>\n"
        '    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>\n'
        '    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>\n'
        "  </manifest>\n"
        "  <spine>\n"
        '    <itemref idref="ch1"/>\n'
        '    <itemref idref="ch2"/>\n'
        "  </spine>\n"
        "</package>\n"
    )

    def chapter(no, title):
        paras = "".join(
            f"<p>第{no}章段落 {i}：EPUB fixture 中文与 English mixed text。</p>"
            for i in range(1, 4)
        )
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml">\n'
            f"<head><title>{title}</title></head>\n"
            f"<body><h1>{title}</h1>{paras}</body>\n"
            "</html>\n"
        )

    return _zip_files({
        "mimetype": "application/epub+zip",
        "META-INF/container.xml": container,
        "OEBPS/content.opf": opf,
        "OEBPS/ch1.xhtml": chapter(1, "第一章 起点"),
        "OEBPS/ch2.xhtml": chapter(2, "第二章 终点"),
    })


_ODF_NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" '
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"'
)


def _odf_office(inner):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<office:document-content {_ODF_NS} office:version="1.2">\n'
        f"<office:body>{inner}</office:body>\n"
        "</office:document-content>\n"
    )


def odt_bytes():
    """最小 ODT：标题 + 两段正文"""
    inner = (
        "<office:text>"
        '<text:h text:outline-level="1">ODT 测试标题</text:h>'
        "<text:p>这是 ODT fixture 的第一段，包含中英文 Mixed Text。</text:p>"
        "<text:p>第二段落：全部处理在本地浏览器完成。</text:p>"
        "</office:text>"
    )
    return _zip_files({
        "mimetype": "application/vnd.oasis.opendocument.text",
        "META-INF/manifest.xml": '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
        "content.xml": _odf_office(inner),
    })


def ods_bytes():
    """最小 ODS：一张表 2×3（表头 + 两行数据）"""
    cell = '<table:table-cell office:value-type="string"><text:p>{}</text:p></table:table-cell>'
    row = "<table:table-row>" + cell.format("名称") + cell.format("数量") + cell.format("单价") + "</table:table-row>"
    row2 = (
        "<table:table-row>"
        + cell.format("机械键盘")
        + cell.format("2")
        + cell.format("199.5")
        + "</table:table-row>"
    )
    inner = (
        "<office:spreadsheet>"
        '<table:table table:name="数据">'
        + row + row2 +
        "</table:table>"
        "</office:spreadsheet>"
    )
    return _zip_files({
        "mimetype": "application/vnd.oasis.opendocument.spreadsheet",
        "content.xml": _odf_office(inner),
    })


def odp_bytes():
    """最小 ODP：两页，每页一个标题文本框"""
    def page(title, body):
        return (
            "<draw:page draw:name=\"p\">"
            "<draw:frame draw:layer=\"layout\" svg:x=\"2cm\" svg:y=\"2cm\" svg:width=\"20cm\" svg:height=\"4cm\">"
            f"<text:p>{title}</text:p>"
            "</draw:frame>"
            "<draw:frame draw:layer=\"layout\" svg:x=\"2cm\" svg:y=\"7cm\" svg:width=\"20cm\" svg:height=\"8cm\">"
            f"<text:p>{body}</text:p>"
            "</draw:frame>"
            "</draw:page>"
        )

    inner = (
        "<office:presentation>"
        + page("ODP 演示第一页", "要点：ODP fixture 内容甲")
        + page("ODP 演示第二页", "要点：ODP fixture 内容乙")
        + "</office:presentation>"
    )
    return _zip_files({
        "mimetype": "application/vnd.oasis.opendocument.presentation",
        "content.xml": _odf_office(inner),
    })


def xlsx_bytes():
    """最小 XLSX（zipfile + 手写 XML）：sharedStrings + sheet1，2 行 × 3 列"""
    content_types = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        '  <Default Extension="xml" ContentType="application/xml"/>\n'
        '  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n'
        '  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n'
        '  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>\n'
        "</Types>\n"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n'
        "</Relationships>\n"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n'
        '  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>\n'
        "</workbook>\n"
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>\n'
        '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>\n'
        "</Relationships>\n"
    )
    strings = ["名称", "数量", "单价", "机械键盘", "无线鼠标"]
    shared = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">\n'
        % (len(strings), len(strings))
        + "".join(f"<si><t>{s}</t></si>" for s in strings)
        + "</sst>\n"
    )
    sheet = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n'
        "<sheetData>\n"
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>\n'
        '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>2</v></c><c r="C2"><v>199.5</v></c></row>\n'
        '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>3</v></c><c r="C3"><v>49.9</v></c></row>\n'
        "</sheetData>\n"
        "</worksheet>\n"
    )
    return _zip_files({
        "[Content_Types].xml": content_types,
        "_rels/.rels": rels,
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": wb_rels,
        "xl/sharedStrings.xml": shared,
        "xl/worksheets/sheet1.xml": sheet,
    })


def html_file_bytes():
    """HTML：标题/段落/列表/表格/引用 + 应被剔除的 script/style"""
    html = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>测试网页 Fixture</title>
<style>body { color: #222; }</style>
</head>
<body>
<h1>测试网页标题</h1>
<p>这是 HTML fixture 的段落，包含中英文 Mixed Text。</p>
<ul><li>要点甲</li><li>要点乙</li><li>要点丙</li></ul>
<table>
  <tr><th>列A</th><th>列B</th></tr>
  <tr><td>1</td><td>2</td></tr>
</table>
<blockquote>引用：隐私模型不允许经服务器抓取网页。</blockquote>
<script>console.log("should be removed");</script>
</body>
</html>
"""
    return html.encode("utf-8")


def svg_file_bytes():
    """简单 SVG（显式 width/height，供浏览器光栅化）"""
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">\n'
        '  <rect x="0" y="0" width="320" height="200" fill="#eef4ff"/>\n'
        '  <circle cx="90" cy="96" r="56" fill="#2b6cb0"/>\n'
        '  <rect x="170" y="44" width="110" height="104" rx="10" fill="#48bb78"/>\n'
        '  <polygon points="160,10 176,44 144,44" fill="#ed8936"/>\n'
        "</svg>\n"
    )
    return svg.encode("utf-8")


def webp_bytes(size=(640, 480)):
    """PIL 生成的 WebP（格式转换用）"""
    from PIL import Image, ImageDraw

    im = Image.new("RGB", size, (36, 82, 160))
    d = ImageDraw.Draw(im)
    d.ellipse((60, 60, size[0] - 60, size[1] - 60), fill=(240, 180, 40))
    d.rectangle((size[0] // 2 - 20, 20, size[0] // 2 + 20, size[1] - 20), fill=(20, 20, 20))
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=88)
    return buf.getvalue()


def multipage_tiff_bytes():
    """两页 TIFF（PIL save_all，TIFF 转 PDF 用）"""
    from PIL import Image

    im1 = Image.new("RGB", (240, 160), (200, 60, 50))
    im2 = Image.new("RGB", (240, 160), (50, 90, 200))
    buf = io.BytesIO()
    im1.save(buf, format="TIFF", save_all=True, append_images=[im2])
    return buf.getvalue()


def fake_heic_bytes():
    """非法字节的假 .heic（HEIC 工具失败链路用；Chromium 无法解码）"""
    return b"NOT-A-REAL-HEIC-FILE \x00\x01\x02 invalid payload for failure tests"


def fixture_font_bytes():
    """真实字体夹具（设置 → 外挂字体上传链路用）：复制 public/fonts 内的 Text 子集 TTF"""
    src = Path(__file__).resolve().parent.parent / "public" / "fonts" / "text" / "NotoSansSC-Regular-Text.ttf"
    if src.exists():
        return src.read_bytes()
    return b""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    files = {
        "multi3.pdf": pdf_bytes(3, "示例文档"),
        "whiteborder.pdf": whiteborder_pdf(),
        "multi8.pdf": pdf_bytes(8, "长文档拆分"),
        "rotated90.pdf": rotated_pdf(),
        "smask_alpha.pdf": smask_pdf(),
        "downscaled_img.pdf": downscaled_img_pdf(),
        "tiling_pattern.pdf": tiling_pattern_pdf(),
        "scan2.pdf": scan_pdf(),
        "enc_user123.pdf": encrypted_pdf(),
        "photo_l.jpg": big_image_bytes("JPEG", (1200, 900)),
        "photo_p.jpg": big_image_bytes("JPEG", (900, 1200), (200, 120, 40)),
        "alpha.png": alpha_png_bytes(),
        "doc.docx": docx_bytes(),
        "slides.pptx": pptx_bytes(),
        "corrupted.pdf": truncated_pdf(),
        # 「更多 / 创建 PDF」簇
        "sample.txt": text_file_bytes(),
        "sample.log": log_file_bytes(),
        "sample.csv": csv_file_bytes(),
        "sample.md": md_file_bytes(),
        "sample.rtf": rtf_file_bytes(),
        "sample.epub": epub_bytes(),
        "sample.odt": odt_bytes(),
        "sample.ods": ods_bytes(),
        "sample.odp": odp_bytes(),
        "sample.xlsx": xlsx_bytes(),
        "sample.html": html_file_bytes(),
        "diagram.svg": svg_file_bytes(),
        "photo.webp": webp_bytes(),
        "multi2.tiff": multipage_tiff_bytes(),
        "fake.heic": fake_heic_bytes(),
        # 设置 → 外挂字体：真实 TTF 上传链路
        "testfont.ttf": fixture_font_bytes(),
    }
    for name, data in files.items():
        if not data:
            print(f"{name}: (skipped, source missing)")
            continue
        (OUT / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes")
    print(f"\n夹具输出目录: {OUT}")


if __name__ == "__main__":
    main()


# ---------------------------------------------------------------------------
# 富渲染夹具（md2pdf 富模式）：行内/独立数学公式、Mermaid 流程图、markmap 思维导图。
# 追加块：只新增 rich.md，不改动上方既有夹具逻辑。
# ---------------------------------------------------------------------------

def rich_md_bytes():
    """Markdown 富渲染：KaTeX 行内/独立公式 + Mermaid（classDef 上色）+ 思维导图 + 表格/代码/引用"""
    text = r"""# 傅里叶与流程

这是一个富渲染测试文档，能量公式 $E=mc^2$ 出现在中文句子里，
希腊字母 $\alpha+\beta$ 紧邻 CJK 文本，还有负数 $-1$ 的情形。

独立公式如下：

$$\int_0^\infty e^{-x^2}\,dx=\frac{\sqrt{\pi}}{2}$$

## 流程图

```mermaid
flowchart TD
    A[开始] --> B{是否继续?}
    B -->|是| C[处理]
    C --> D[结束]
    B -->|否| E[终止]
    classDef good fill:#2f855a,stroke:#1c4532,color:#ffffff;
    classDef bad fill:#c53030,stroke:#742a2a,color:#ffffff;
    class C,D good
    class E bad
```

## 产品结构

```mindmap
- 产品规划
  - 平台
    - 引擎内核
    - 渲染管线
  - 协作
    - 权限中心
    - 消息通知
  - 分析
    - 数据看板
    - 报表导出
```

## 数据表

| 指标 | 数值 | 单位 |
| --- | --- | --- |
| 频率 | 50 | Hz |
| 电压 | 220 | V |
| 电流 | 10 | A |

```js
console.log("富渲染 fixture");
```

> 引用：全部处理在本地浏览器完成，文件不出浏览器。

---

- [x] 分隔线回归：`---` 走 Typst 引擎需 #horizontalrule 定义（pandoc fragment 缺模板）
- [ ] 未完成任务项

文档到此结束。
"""
    return text.encode("utf-8")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    rich_data = rich_md_bytes()
    (OUT / "rich.md").write_bytes(rich_data)
    print(f"rich.md: {len(rich_data)} bytes")
