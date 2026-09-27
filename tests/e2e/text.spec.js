// 文本提取 e2e：原生文字 PDF 提取预览与下载；扫描件空文本提示
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('text 工具', () => {
  test.beforeEach(() => ensureFixtures());

  test('原生文字提取：预览非空 + 下载 TXT', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'text');
    await upload(page, ['multi3.pdf'], false);
    await page.getByRole('button', { name: '开始提取' }).click();
    await page.getByRole('button', { name: '下载 TXT' }).waitFor({ timeout: 60_000 });
    const pre = page.locator('pre.text-preview');
    await expect(pre).toContainText('Fixture Page 1');
    const p = await saveDownload(page, '下载 TXT', 'text-out.txt');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('扫描件：提示无文字层并建议 OCR', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'text');
    await upload(page, ['scan2.pdf'], false);
    await page.getByRole('button', { name: '开始提取' }).click();
    await page.getByRole('button', { name: '下载 TXT' }).waitFor({ timeout: 60_000 });
    await expect(page.getByText(/未提取到文字/)).toBeVisible();
  });
});
