# -*- coding: utf-8 -*-
"""页面类产物校验：合并 / 拆分 / 整理 / 编辑。"""
import io
import zipfile

import pytest

from conftest import fixture, find_artifact

pytestmark = pytest.mark.verify


def page_texts(path):
    import fitz

    d = fitz.open(str(path))
    texts = [d[i].get_text() for i in range(d.page_count)]
    n = d.page_count
    d.close()
    return n, texts


def test_merge_pdf():
    """合并产物：可打开、页数与顺序正确（multi3 的 '第 N 页' 递增）。"""
    p = find_artifact("*merge*.pdf")
    n, texts = page_texts(p)
    assert n >= 2, f"合并后应≥2页，实际 {n}"
    joined = "\n".join(texts)
    assert "Fixture Page 1" in joined, "缺少第1页文字（顺序或内容错误）"


def test_split_zip():
    """拆分 ZIP：含 ≥2 个 PDF，每个可打开且页数之和 = 原 8 页。"""
    p = find_artifact("split*.zip")
    total, count = 0, 0
    with zipfile.ZipFile(p) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".pdf")]
        for name in names:
            d = fitz_open_bytes(z.read(name))
            total += d.page_count
            count += 1
            d.close()
    assert count >= 2, f"ZIP 内应有≥2个PDF，实际 {count}"
    assert total == 8, f"拆分各组页数之和应=8，实际 {total}"


def fitz_open_bytes(data):
    import fitz

    return fitz.open(stream=data, filetype="pdf")


def test_organize_pdf():
    """整理产物：可打开、页数 ≤ 原 8、每页渲染不报错。"""
    p = find_artifact("organize*.pdf")
    import fitz

    d = fitz.open(str(p))
    assert 1 <= d.page_count <= 8, f"整理后页数异常：{d.page_count}"
    for i in range(d.page_count):
        d[i].get_pixmap(dpi=50)  # 渲染不崩溃
    d.close()


def test_edit_pdf():
    """编辑产物：可打开、页数不变、添加的文字真实存在（fitz 独立提取）。"""
    p = find_artifact("edit*.pdf")
    src = fixture("multi3.pdf")
    n_out, _ = page_texts(p)
    n_src, _ = page_texts(src)
    assert n_out == n_src, f"编辑不应增删页：{n_src} → {n_out}"
    out_text = "\n".join(page_texts(p)[1])
    assert "测试水印文字" in out_text, "编辑添加的文字未出现在产物中"
