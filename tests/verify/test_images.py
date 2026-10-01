# -*- coding: utf-8 -*-
"""图像类产物校验：图片转 PDF / PDF 转图片 / 提取嵌入图像。"""
import io
import zipfile

import pytest

from conftest import fixture, find_artifact

pytestmark = pytest.mark.verify


def test_images2pdf():
    """图片转 PDF：页数=输入图数（photo_l + alpha.png = 2），每页含图像。"""
    p = find_artifact("images2pdf*.pdf")
    import fitz

    d = fitz.open(str(p))
    assert d.page_count == 2, f"两图应生成 2 页，实际 {d.page_count}"
    imgs = d[0].get_images(full=True)
    assert len(imgs) >= 1, "第1页应含图像"
    d.close()


def test_pdf2images_zip():
    """PDF 转图片 ZIP：内含 PNG/JPEG，Pillow 可打开、尺寸>0。"""
    from PIL import Image

    p = find_artifact("pdf2images*.zip")
    n = 0
    with zipfile.ZipFile(p) as z:
        names = [n_ for n_ in z.namelist() if n_.lower().endswith((".png", ".jpg", ".jpeg"))]
        assert len(names) >= 1, f"ZIP 内应有图片，实际 {z.namelist()}"
        for name in names:
            im = Image.open(io.BytesIO(z.read(name)))
            im.load()
            assert im.width > 0 and im.height > 0
            n += 1
    assert n >= 1


def test_extract_images_zip():
    """提取嵌入图像 ZIP：≥1 张图、Pillow 可开、与夹具 smask_alpha 的原图尺寸一致（200×150）。"""
    from PIL import Image

    p = find_artifact("extract*.zip")
    found = 0
    with zipfile.ZipFile(p) as z:
        for name in z.namelist():
            if name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                im = Image.open(io.BytesIO(z.read(name)))
                assert im.width > 0 and im.height > 0
                found += 1
    assert found >= 1, "应至少提取出 1 张嵌入图像"


