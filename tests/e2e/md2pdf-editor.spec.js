// md2pdf 在线编辑器 e2e：在线编辑 + 即时/版式双预览 + 内容暂存 + 上传载入
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

/** 切到「PDF 版式」预览（默认预览为即时 HTML） */
async function toLayoutPreview(page) {
  await page.getByRole('button', { name: 'PDF 版式' }).click();
}

test.describe('md2pdf 在线编辑器', () => {
  test.beforeEach(() => ensureFixtures());

  test('在线输入 → 即时预览 → 版式预览 → 手动转换 → 下载；刷新后暂存还原', async ({ page }) => {
    await openTool(page, 'md2pdf');
    const ta = page.locator('[data-md-text]');
    await ta.fill('# 编辑器测试\n\n正文段落，含行内公式 $E=mc^2$ 与 **加粗**。\n\n- 列表项一\n- 列表项二\n');
    // 即时预览（默认）：KaTeX 公式矢量渲染
    await expect(page.locator('.mdx-paper .katex').first()).toBeVisible({ timeout: 30_000 });
    // 切版式预览（防抖 1.5s + 首次加载 pdf.js）
    await toLayoutPreview(page);
    await expect(page.locator('[data-md-pv-pages] canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-md-pv-status]')).toContainText('共 1 页');
    // 暂存指示
    await expect(page.locator('[data-md-draft-state]')).toContainText('已暂存');
    // 刷新后草稿还原（内容 + 暂存时间 + 版式预览模式）
    await page.reload();
    await page.locator('[data-md-text]').waitFor();
    await expect(page.locator('[data-md-text]')).toHaveValue(/编辑器测试/);
    await expect(page.locator('[data-md-draft-state]')).toContainText('已暂存');
    // 还原后自动预览恢复（版式模式随草稿还原）
    await expect(page.locator('[data-md-pv-pages] canvas').first()).toBeVisible({ timeout: 60_000 });
    // 手动转换 → 结果卡 → 下载
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'md2pdf-editor-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  test('上传 .md 载入编辑器（可继续修改）→ 转换产物用文件名', async ({ page }) => {
    await openTool(page, 'md2pdf');
    await upload(page, ['rich.md'], false);
    await expect(page.locator('[data-md-text]')).toHaveValue(/傅里叶与流程/);
    await expect(page.locator('[data-md-text]')).toHaveValue(/```mermaid/);
    // 即时预览渲染出 mermaid 图形
    await expect(page.locator('.mdx-paper svg').first()).toBeVisible({ timeout: 60_000 });
    // 版式预览（富渲染含 mermaid/markmap，页数 ≥2）
    await toLayoutPreview(page);
    await expect(page.locator('[data-md-pv-pages] canvas').first()).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-md-pv-status]')).toContainText('共 2 页');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 90_000 });
    // 默认命名规则：原名-操作-参数-时间（产物名以源文件名 rich 开头）
    await expect(page.locator('.result-artifact .ra-name')).toHaveText(/^rich-.+\.pdf$/);
  });

  test('清空按钮：清内容与暂存（确认弹窗）', async ({ page }) => {
    await openTool(page, 'md2pdf');
    const ta = page.locator('[data-md-text]');
    await ta.fill('# 待清空\n\n内容');
    await expect(page.locator('[data-md-draft-state]')).toContainText('已暂存', { timeout: 10_000 });
    await page.getByRole('button', { name: '清空' }).click();
    // 应用内 shadcn AlertDialog 确认（原生 confirm 已移除）
    await page.locator('[data-cd-confirm]').click();
    await expect(ta).toHaveValue('');
    await expect(page.locator('[data-md-draft-state]')).toContainText('未暂存');
    await expect(page.getByRole('button', { name: '开始转换' })).toBeDisabled();
    await expect(page.locator('[data-md-pv-status]')).toContainText('待输入');
  });

  test('多引擎：内置引擎转 Word(.docx) 产出合法包', async ({ page }) => {
    await openTool(page, 'md2pdf');
    const ta = page.locator('[data-md-text]');
    await ta.fill('# Word 引擎测试\n\n含 **粗体** 与表格。\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
    await page.locator('select').first().selectOption('docx');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'md2pdf-word-out.docx');
    expect(fs.statSync(p).size).toBeGreaterThan(2000);
  });
});
