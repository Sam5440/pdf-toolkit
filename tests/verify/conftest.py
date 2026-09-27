# -*- coding: utf-8 -*-
"""python 独立校验层公共设施。

定位：浏览器（Playwright e2e）生产产物 → tests/e2e/.artifacts/，
本目录用 pypdf / PyMuPDF(fitz) / Pillow 独立交叉验证产物正确性。
产物只读；某工具未产出产物时对应测试自动 skip（不算失败）。
"""
import fnmatch
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "tests" / "e2e" / ".artifacts"
FIXTURES = ROOT / "tests" / "fixtures" / "out"


def find_artifact(pattern: str) -> Path:
    """按文件名通配符在 .artifacts 中查找产物（唯一命中返回；缺失则 skip 当前测试）。

    命名约定见 tests/README.md；e2e 用 helpers.saveDownload(page, btn, saveName)
    以精确名保存，此处仍用 glob 以兼容手动重跑/加后缀的情况。
    """
    if not ARTIFACTS.is_dir():
        pytest.skip(f"产物目录不存在：{ARTIFACTS}（先运行 e2e）")
    hits = sorted(p for p in ARTIFACTS.iterdir() if fnmatch.fnmatch(p.name.lower(), pattern.lower()))
    if not hits:
        pytest.skip(f"未找到产物 {pattern}（对应 e2e 未产出，跳过校验）")
    return hits[0]


def fixture(name: str) -> Path:
    """读取原始夹具（用于对照验证）。缺失直接 fail——那是环境问题不是产物问题。"""
    p = FIXTURES / name
    if not p.is_file():
        pytest.fail(f"夹具缺失：{p}，请运行 python3 scripts/build_fixtures.py")
    return p


def mean_abs_pixel_diff(pdf_a: Path, pdf_b: Path, page: int = 0, dpi: int = 72) -> float:
    """两份 PDF 同页渲染的像素平均绝对差（0-255）。用于水印/叠加存在性验证。"""
    import fitz

    def render(path):
        d = fitz.open(str(path))
        pix = d[page].get_pixmap(dpi=dpi)
        data = pix.samples
        d.close()
        return data

    a, b = render(pdf_a), render(pdf_b)
    assert len(a) == len(b), f"渲染尺寸不一致：{len(a)} vs {len(b)}"
    n = len(a)
    return sum(abs(a[i] - b[i]) for i in range(0, n, 7)) / (n / 7)
