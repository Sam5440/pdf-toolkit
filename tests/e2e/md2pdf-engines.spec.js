// md2pdf 多引擎 e2e：Typst 排版引擎（pandoc→typst + typst.ts WASM）与 Pandoc 高保真 Word 引擎。
// 前置：node scripts/fetch-engines.mjs 已重建 public/engines/（CI/离线跑前先执行）。
// 链路要求：真实点击导航、真实 filechooser 上传、真实下载捕获（禁止 DOM 注入伪造）。
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openTool, upload, saveDownload, FIXTURES } from './helpers.js';

const ROOT = path.resolve(FIXTURES, '../..');

test.beforeAll(() => {
  if (!fs.existsSync(path.join(FIXTURES, 'rich.md'))) {
    execSync('python3 scripts/build_fixtures.py', { cwd: ROOT, stdio: 'inherit' });
  }
});

test.describe('md2pdf · WASM 引擎', () => {
  test('Typst 排版引擎：rich.md → 排版级 PDF（中文/公式/表格）', async ({ page }) => {
    test.setTimeout(300_000); // 28MB wasm + 字体首次加载 + Haskell RTS 初始化
    await openTool(page, 'md2pdf');
    await upload(page, ['rich.md'], false);
    await page.locator('select').first().selectOption('pdf');
    await page.locator('select').nth(1).selectOption('typst');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 280_000 });
    const p = await saveDownload(page, '下载', 'md2pdf-typst-out.pdf');
    const buf = fs.readFileSync(p);
    expect(buf.length).toBeGreaterThan(10_000);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('Pandoc 高保真引擎：rich.md → 真 OOXML Word', async ({ page }) => {
    test.setTimeout(300_000); // 58MB wasm + RTS 初始化
    await openTool(page, 'md2pdf');
    await upload(page, ['rich.md'], false);
    await page.locator('select').first().selectOption('docx');
    await page.locator('select').nth(1).selectOption('pandoc');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 280_000 });
    const p = await saveDownload(page, '下载', 'md2pdf-pandoc-out.docx');
    const buf = fs.readFileSync(p);
    expect(buf.length).toBeGreaterThan(5_000);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK'); // zip 容器
  });
});
