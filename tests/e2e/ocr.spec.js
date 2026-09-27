// OCR e2e：扫描件 → 可搜索 PDF + TXT（fitz 验证文字层与页面图像）；原生文字层文档自动跳过
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('ocr 工具', () => {
  test.beforeEach(() => ensureFixtures());

  test('扫描件识别：可搜索 PDF 产物 fitz 验证（图像页+文字层）', async ({ page }) => {
    test.setTimeout(300_000);
    await openTool(page, 'ocr');
    await upload(page, ['scan2.pdf'], false);
    // 默认语言 eng+chi_sim、DPI 200、输出两者、自动模式
    await page.getByRole('button', { name: '开始识别' }).click();
    await page.getByRole('button', { name: '下载', exact: true }).first().waitFor({ timeout: 240_000 });

    const p = await saveDownload(page, '下载', 'ocr-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
    // 断言无外网请求的语言包加载已在网络层验证：tessdata 为本地文件（此处验证产物）
    const out = execSync(
      `python3 -c "
import fitz
d = fitz.open('${p}')
assert d.page_count == 2, d.page_count
assert any(len(pg.get_images(full=True)) >= 1 for pg in d), '缺少页面图像'
assert any(pg.get_text().strip() for pg in d), '缺少可搜索文字层'
print('OK', d.page_count)
"`, { stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    expect(out).toContain('OK');
  });

  test('原生文字层文档：自动模式直接提取不报错', async ({ page }) => {
    test.setTimeout(300_000);
    await openTool(page, 'ocr');
    await upload(page, ['multi3.pdf'], false);
    await page.getByRole('button', { name: '开始识别' }).click();
    await page.getByRole('button', { name: '下载', exact: true }).first().waitFor({ timeout: 240_000 });
    // 两种合法结果：出现"已含文字层"提示，或正常出产物
    const info = await page.getByText('已含文字层').count();
    const arts = await page.getByRole('button', { name: '下载', exact: true }).count();
    expect(info > 0 || arts > 0).toBeTruthy();
  });

  test('边界：未上传文件 → toast 提示', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'ocr');
    await page.getByRole('button', { name: '开始识别' }).click();
    await expect(page.locator('.toast-error, .toast')).toHaveText(/请先选择/, { timeout: 5_000 });
  });
});
