# -*- coding: utf-8 -*-
"""比较工具产物校验：差异报告文本。

比较工具主产物是 UI 内的双栏视图与高亮位图；e2e 若导出报告/差异页图则在此校验。
"""
import pytest

from conftest import find_artifact

pytestmark = pytest.mark.verify


def test_compare_report_txt():
    """差异报告：含'相同/差异'关键字与页码信息。"""
    p = find_artifact("*report*.txt")
    text = p.read_bytes().decode("utf-8", errors="replace")
    print(f"\n比较报告（前300字）：\n{text[:300]}")
    assert ("相同" in text) or ("差异" in text) or ("diff" in text.lower()), "报告缺少比较结论字样"


def test_compare_diff_images():
    """差异高亮页图（若导出为 ZIP 或 PNG）：Pillow 可打开。"""
    from PIL import Image

    p = find_artifact("compare*.zip")
    import io
    import zipfile

    found = 0
    with zipfile.ZipFile(p) as z:
        for name in z.namelist():
            if name.lower().endswith((".png", ".jpg", ".jpeg")):
                im = Image.open(io.BytesIO(z.read(name)))
                assert im.width > 0
                found += 1
    assert found >= 1
