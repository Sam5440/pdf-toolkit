// 压缩工具 e2e：真实上传 → 三模式寻优 → 推荐方案 + 候选表 → 下载
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { ensureFixtures, openTool, upload, saveDownload, ARTIFACTS } from './helpers.js';

test.describe('compress 工具', () => {
  test.beforeEach(() => ensureFixtures());

  test('成功链路：智能+无损压缩扫描件并下载推荐结果', async ({ page }) => {
    test.setTimeout(300_000);
    await openTool(page, 'compress');
    await upload(page, ['scan2.pdf'], false);
    // 目标 1MB（夹具远小于此，会快速达标）；只保留智能+结构无损，避免栅格化拖慢
    await page.locator('input[type=number]').first().fill('1');
    const boxes = page.locator('.checkbox-row input[type=checkbox]');
    await boxes.nth(1).uncheck(); // raster 关闭
    await page.getByRole('button', { name: '开始压缩' }).click();

    // 候选进度/结果出现
    await page.getByText('推荐方案').waitFor({ timeout: 240_000 });
    await expect(page.getByText('全部候选')).toBeVisible();

    const p = await saveDownload(page, '下载推荐结果', 'compress-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);

    // 候选表内每行有独立下载
    await expect(page.getByRole('button', { name: '下载此版本' }).first()).toBeVisible();
    // 任务自动记录：结果卡出现「已自动存入历史」提示
    await expect(page.getByText('已自动存入历史').first()).toBeVisible();
  });

  test('边界：未上传文件点开始 → toast 提示且无结果卡', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'compress');
    await page.getByRole('button', { name: '开始压缩' }).click();
    await expect(page.locator('.toast-error, .toast')).toHaveText(/请先选择/, { timeout: 5_000 });
    await expect(page.getByText('推荐方案')).toHaveCount(0);
  });

  test('边界：全部模式取消 → 提示至少选择一种模式', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'compress');
    await upload(page, ['scan2.pdf'], false);
    const boxes = page.locator('.checkbox-row input[type=checkbox]');
    await boxes.nth(0).uncheck();
    await boxes.nth(1).uncheck();
    await boxes.nth(2).uncheck();
    await page.getByRole('button', { name: '开始压缩' }).click();
    await expect(page.locator('.toast-error, .toast')).toHaveText(/至少选择一种/, { timeout: 5_000 });
  });
});
