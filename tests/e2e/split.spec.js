// 拆分 PDF e2e（subagent A）
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('拆分 PDF 工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'split');
  });

  test('每N页=3 拆分 8 页文档 → 3 组产物 → 打包下载 ZIP', async ({ page }) => {
    await upload(page, ['multi8.pdf'], false);
    // 默认每页一档：8 组
    await expect(page.getByText('预计输出 8 个文件')).toBeVisible({ timeout: 15000 });

    // 切换到每N页一档，N=3 → 3 组
    await page.locator('input[data-mode="every"]').check();
    await page.locator('input[data-split="n"]').fill('3');
    await expect(page.getByText('预计输出 3 个文件')).toBeVisible();
    await expect(page.locator('.range-chip')).toHaveCount(3);

    await page.getByRole('button', { name: '开始拆分' }).click();
    await expect(page.getByText('拆分完成：3 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.result-artifact')).toHaveCount(3);
    await expect(page.locator('.result-artifact').first()).toContainText('第1-3页');

    const p = await saveDownload(page, '打包下载 ZIP', 'split-groups.zip');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('边界：无文件时开始禁用；非法范围 9- 红字提示且不出产物', async ({ page }) => {
    const go = page.getByRole('button', { name: '开始拆分' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi8.pdf'], false);
    await expect(page.getByText('预计输出 8 个文件')).toBeVisible({ timeout: 15000 });
    await expect(go).toBeEnabled();

    // 非法范围 → 红字提示 + 开始禁用，不出产物
    await page.locator('input[data-mode="ranges"]').check();
    const ranges = page.locator('textarea[data-split="ranges"]');
    await ranges.fill('9-');
    await expect(page.locator('.alert-error')).toBeVisible();
    await expect(go).toBeDisabled();
    await expect(page.locator('.result-artifact')).toHaveCount(0);

    // 修正为合法值后恢复可用
    await ranges.fill('1-3\n4,6');
    await expect(page.getByText('预计输出 2 个文件')).toBeVisible();
    await expect(go).toBeEnabled();
  });
});
