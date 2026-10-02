// md2pdf 在线编辑器 e2e：在线编辑 + 实时预览（PDF 页面图）+ 内容暂存 + 上传载入
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('md2pdf 在线编辑器', () => {
  test.beforeEach(() => ensureFixtures());

  test('在线输入 → 自动预览 → 手动转换 → 下载；刷新后暂存还原', async ({ page }) => {
    await openTool(page, 'md2pdf');
    const ta = page.locator('[data-md-text]');
    await ta.fill('# 编辑器测试\n\n正文段落，含行内公式 $E=mc^2$ 与 **加粗**。\n\n- 列表项一\n- 列表项二\n');
    // 预览自动刷新（防抖 1.2s + 首次加载 pdf.js）
    await expect(page.locator('[data-md-pv-pages] canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-md-pv-status]')).toContainText('共 1 页');
    // 暂存指示
    await expect(page.locator('[data-md-draft-state]')).toContainText('已暂存');
    // 刷新后草稿还原（内容 + 暂存时间）
    await page.reload();
    await page.locator('[data-md-text]').waitFor();
    await expect(page.locator('[data-md-text]')).toHaveValue(/编辑器测试/);
    await expect(page.locator('[data-md-draft-state]')).toContainText('已暂存');
    // 还原后自动预览恢复
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
    // 预览（富渲染含 mermaid/markmap，页数 ≥2）
    await expect(page.locator('[data-md-pv-pages] canvas').first()).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('[data-md-pv-status]')).toContainText('共 2 页');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('.result-artifact .ra-name')).toContainText('rich.pdf');
  });

  test('清空按钮：清内容与暂存（确认弹窗）', async ({ page }) => {
    await openTool(page, 'md2pdf');
    const ta = page.locator('[data-md-text]');
    await ta.fill('# 待清空\n\n内容');
    await expect(page.locator('[data-md-draft-state]')).toContainText('已暂存', { timeout: 10_000 });
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: '清空' }).click();
    await expect(ta).toHaveValue('');
    await expect(page.locator('[data-md-draft-state]')).toContainText('未暂存');
    await expect(page.getByRole('button', { name: '开始转换' })).toBeDisabled();
    await expect(page.locator('[data-md-pv-status]')).toContainText('待输入');
  });
});
