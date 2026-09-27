// Office 近似转换 e2e：docx/pptx → PDF（真实下载 + fitz 页数验证）；旧格式明确拒绝
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ensureFixtures, openTool, upload, saveDownload, ARTIFACTS, FIXTURES } from './helpers.js';

test.describe('office 工具', () => {
  test.beforeEach(() => ensureFixtures());

  test('docx → PDF 近似转换成功（fitz 验证页数>0）', async ({ page }) => {
    test.setTimeout(180_000);
    await openTool(page, 'office');
    await upload(page, ['doc.docx'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await page.getByRole('button', { name: '下载 PDF' }).waitFor({ timeout: 120_000 });
    const p = await saveDownload(page, '下载 PDF', 'office-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
    const out = execSync(
      `python3 -c "import fitz; d=fitz.open('${p}'); assert d.page_count >= 1; [pg.get_pixmap(dpi=30) for pg in d]; print(d.page_count)"`,
    ).toString().trim();
    expect(Number(out)).toBeGreaterThanOrEqual(1);
  });

  test('pptx → PDF 近似转换成功', async ({ page }) => {
    test.setTimeout(180_000);
    await openTool(page, 'office');
    await upload(page, ['slides.pptx'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await page.getByRole('button', { name: '下载 PDF' }).waitFor({ timeout: 120_000 });
    const p = await saveDownload(page, '下载 PDF', 'pptx-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('旧版 .doc → 明确提示另存为，不出产物', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'office');
    const chooserP = page.waitForEvent('filechooser');
    await page.locator('.dropzone').click();
    const chooser = await chooserP;
    const tmp = path.join(ARTIFACTS, 'old.doc');
    fs.writeFileSync(tmp, Buffer.from('OLD BINARY FORMAT'));
    await chooser.setFiles([tmp]);
    await expect(page.getByText(/另存为/).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByRole('button', { name: '下载 PDF' })).toHaveCount(0);
  });
});
