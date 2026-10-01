# -*- coding: utf-8 -*-
"""比较工具产物校验：差异报告文本。

比较工具主产物是 UI 内的双栏视图与高亮位图；e2e 若导出报告/差异页图则在此校验。
"""
import pytest

from conftest import find_artifact

pytestmark = pytest.mark.verify



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
