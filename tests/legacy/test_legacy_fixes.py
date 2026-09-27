# 旧版修复回归：不启动服务，直接测函数
import importlib.util
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location("pdf_optimizer", os.path.join(ROOT, "pdf_optimizer.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_valid_history_id():
    assert mod._valid_history_id("d3cb5dd0a21e")
    assert not mod._valid_history_id("")
    assert not mod._valid_history_id("..")
    assert not mod._valid_history_id("../..")
    assert not mod._valid_history_id("d3cb5dd0a21e/../../code")


def test_delete_history_rejects_traversal(tmp_path):
    old_root = mod.HISTORY_ROOT
    mod.HISTORY_ROOT = str(tmp_path / "hist")
    os.makedirs(mod.HISTORY_ROOT)
    secret = tmp_path / "secret"
    secret.mkdir()
    (secret / "keep.txt").write_text("do not delete")
    # 越界删除必须无效
    mod.delete_history("../secret")
    mod.delete_history(".")
    mod.delete_history("")
    assert (secret / "keep.txt").exists()
    # 合法 ID 可删除
    jid = "aaaaaaaaaaaa"
    os.makedirs(os.path.join(mod.HISTORY_ROOT, jid))
    mod.delete_history(jid)
    assert not os.path.isdir(os.path.join(mod.HISTORY_ROOT, jid))
    mod.HISTORY_ROOT = old_root


def test_history_record_rejects_bad_id():
    assert mod.history_record("") is None
    assert mod.history_record("../x") is None


def test_smart_compress_rgb_smask(tmp_path):
    """RGB 带透明图压缩：统计键修复后 rgb/alpha 计数正确、输出可用。"""
    fitz = pytest.importorskip("fitz")
    from PIL import Image
    src = tmp_path / "rgb_alpha.pdf"
    doc = fitz.open()
    page = doc.new_page(width=200, height=200)
    img = Image.new("RGBA", (120, 120), (200, 30, 30, 180))
    img_path = tmp_path / "red.png"
    img.save(img_path)
    page.insert_image(fitz.Rect(20, 20, 160, 160), filename=str(img_path))
    doc.save(str(src))
    doc.close()

    out = tmp_path / "out.pdf"
    stats = mod.smart_compress(str(src), str(out), 0.5, 70, 70)
    assert stats["stats"]["rgb"] >= 1, f"RGB 图像应被重压（stats={stats}）"
    assert stats["stats"]["alpha"] >= 1, f"SMask 应被联动处理（stats={stats}）"
    d2 = fitz.open(str(out))
    assert d2.page_count == 1
    d2.close()
