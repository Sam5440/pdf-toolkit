// Markdown 转 PDF 富渲染 e2e：KaTeX 公式 / Mermaid 图形 / markmap 思维导图 → 全离线栅格化进 PDF。
// 链路要求：真实点击导航、真实 filechooser 上传、真实下载捕获（禁止 DOM 注入伪造）。
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openTool, upload, saveDownload, FIXTURES } from './helpers.js';

const ROOT = path.resolve(FIXTURES, '../..');

test.beforeAll(() => {
  // rich.md 由 build_fixtures.py 末尾追加块生成（与既有夹具同一入口，幂等）
  if (!fs.existsSync(path.join(FIXTURES, 'multi3.pdf')) || !fs.existsSync(path.join(FIXTURES, 'rich.md'))) {
    execSync('python3 scripts/build_fixtures.py', { cwd: ROOT, stdio: 'inherit' });
  }
});

test.describe('md2pdf · 富渲染', () => {
  test('勾选富渲染：公式 + Mermaid + 思维导图 → 下载 PDF', async ({ page }) => {
    test.setTimeout(180_000); // mermaid + markmap 动态 chunk 首次加载较慢
    await openTool(page, 'md2pdf');
    await upload(page, ['rich.md'], false);
    const rich = page.locator('[data-md-rich]');
    await expect(rich).toBeChecked(); // 默认勾选
    await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled();
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 150_000 });
    const p = await saveDownload(page, '下载', 'md2pdf-rich-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(15000); // 图形栅格化产物明显大于纯文本 PDF
  });

  test('取消勾选：走纯文本路径（回归保护）', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'md2pdf');
    await upload(page, ['rich.md'], false);
    await page.locator('[data-md-rich]').uncheck();
    await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled();
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 90_000 });
    const p = await saveDownload(page, '下载', 'md2pdf-rich-off.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });
});
