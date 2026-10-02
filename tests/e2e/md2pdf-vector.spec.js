// md2pdf 文本型 PDF e2e：rich.md（公式/Mermaid/思维导图/表格/代码）→ 下载 md2pdf-vector-out.pdf。
// 验收：产物含图形与内嵌字体（>100KB）且字体未爆炸（<20MB）；结果卡出现文本型标记。
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

test.describe('md2pdf · 文本型 PDF', () => {
  test('富渲染上传 → 文本型 PDF（图形混排 + 内嵌字体，体积受控）', async ({ page }) => {
    test.setTimeout(180_000); // mermaid + markmap 动态 chunk 首次加载较慢
    await openTool(page, 'md2pdf');
    await upload(page, ['rich.md'], false);
    await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled();
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 150_000 });
    const p = await saveDownload(page, '下载', 'md2pdf-vector-out.pdf');
    const size = fs.statSync(p).size;
    expect(size).toBeGreaterThan(100_000); // 公式/图形 PNG + 内嵌 CJK 字体
    expect(size).toBeLessThan(20 * 1024 * 1024); // subset:false 嵌入的字体压缩后 ~1.4MB/字重，未爆炸
    // 结果卡 summary 出现文本型标记（正文可选中/可搜索）
    await expect(page.getByText('可选中·可搜索')).toBeVisible();
    // 页面预览 canvas 出现（预览即最终 PDF 页面）
    await expect(page.locator('.md-pv-page').first()).toBeVisible();
  });
});
