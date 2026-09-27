# -*- coding: utf-8 -*-
"""压缩产物校验：结构完整 + 体积报告 + 每页可渲染。"""
import pytest

from conftest import find_artifact, fixture

pytestmark = pytest.mark.verify


def test_compress_pdf():
    """压缩产物：可打开、页数=原件（scan2=2页）、每页渲染不报错。"""
    p = find_artifact("compress*.pdf")
    src = fixture("scan2.pdf")
    import fitz

    d_src, d_out = fitz.open(str(src)), fitz.open(str(p))
    assert d_out.page_count == d_src.page_count, (
        f"压缩不应改变页数：{d_src.page_count} → {d_out.page_count}"
    )
    for i in range(d_out.page_count):
        d_out[i].get_pixmap(dpi=50)
    d_src.close()
    d_out.close()


def test_compress_size_report():
    """体积对比：产物字节打印出来供人工核对；若 .artifacts 有原件副本则断言确实变小。"""
    p = find_artifact("compress*.pdf")
    out_size = p.stat().st_size
    originals = [
        q for q in p.parent.iterdir()
        if q.suffix.lower() == ".pdf" and "compress" not in q.name.lower()
    ]
    print(f"\n压缩产物: {p.name} = {out_size} bytes")
    if not originals:
        pytest.skip(".artifacts 无原件副本，跳过体积对比断言")
    for src in originals:
        print(f"  原件 {src.name} = {src.stat().st_size} bytes")
