// 提取图片 e2e（subagent C）
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('提取图片工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'extractimages');
  });

  test('smask_alpha.pdf→提取内嵌图像→ZIP 下载', async ({ page }) => {
    await upload(page, ['smask_alpha.pdf']);
    await page.getByRole('button', { name: '开始提取' }).click();
    await expect(page.getByText('提取完成')).toBeVisible();

    // 至少 1 个产物（合成透明模式下主图像 1 张；引擎对 SMask 的去重顺序可能有 +1）
    const n = await page.locator('.result-artifact').count();
    expect(n).toBeGreaterThanOrEqual(1);

    const p = await saveDownload(page, 'ZIP 打包下载', 'extract-out.zip');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('multi3.pdf 无嵌入图像→空态提示', async ({ page }) => {
    await upload(page, ['multi3.pdf']);
    await page.getByRole('button', { name: '开始提取' }).click();
    await expect(page.getByText('未发现可提取的嵌入图像')).toBeVisible();
    await expect(page.locator('.result-artifact')).toHaveCount(0);
  });

  test('参数错误：页码超出范围→报错不出产物', async ({ page }) => {
    await upload(page, ['smask_alpha.pdf']);
    await page.getByLabel('页范围').fill('99');
    await page.getByRole('button', { name: '开始提取' }).click();
    await expect(page.locator('.alert-error')).toBeVisible();
    await expect(page.locator('.result-artifact')).toHaveCount(0);
  });
});
