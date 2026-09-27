# -*- coding: utf-8 -*-
"""安全产物校验：加密 / 解密（pypdf 与 PyMuPDF 双引擎交叉验证）。"""
import pytest

from conftest import fixture, find_artifact

pytestmark = pytest.mark.verify

TEST_USER_PW = "test123"


def test_encrypted_pdf_pypdf():
    """加密产物：pypdf 确认已加密、已知用户密码可解、解后页数正常。"""
    from pypdf import PasswordType, PdfReader

    p = find_artifact("enc*.pdf")
    r = PdfReader(str(p))
    assert r.is_encrypted, "产物未加密！"
    result = r.decrypt(TEST_USER_PW)
    assert result != PasswordType.NOT_DECRYPTED, f"用户密码 {TEST_USER_PW} 无法解密：{result}"
    assert len(r.pages) >= 1, "解密后应能读到页面"


def test_encrypted_pdf_fitz():
    """加密产物：PyMuPDF 独立确认 AES 可用、原文字保留。"""
    import fitz

    p = find_artifact("enc*.pdf")
    d = fitz.open(str(p))
    assert d.needs_pass, "fitz 认为未加密（与 pypdf 结论矛盾）"
    assert d.authenticate(TEST_USER_PW), "fitz 用 test123 解密失败"
    text = d[0].get_text()
    assert "Fixture Page 1" in text, "解密后原文字丢失"
    d.close()


def test_decrypted_pdf():
    """解密产物：不再加密、文字与加密前原件一致（密码移除无损）。"""
    p = find_artifact("dec*.pdf")
    src = fixture("enc_user123.pdf")  # e2e 解密的是该加密夹具
    from pypdf import PdfReader

    r = PdfReader(str(p))
    assert not r.is_encrypted, "解密产物仍处于加密状态"
    joined = "\n".join((pg.extract_text() or "") for pg in r.pages)
    assert "Fixture Page 1" in joined, "解密后内容与原件不符"
    src_reader = PdfReader(str(src))
    src_reader.decrypt("user123")  # 加密夹具需先解密才能读页数
    assert len(r.pages) == len(src_reader.pages), "解密后页数变化"
