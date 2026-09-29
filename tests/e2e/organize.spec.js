// 页面整理 e2e（subagent A）
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('页面整理工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'organize');
  });

  test('全选右转→删除第1页→撤销→再删→拖拽交换前两页→执行→下载', async ({ page }) => {
    await upload(page, ['multi8.pdf'], false);
    const cards = page.locator('.page-card');
    await expect(cards).toHaveCount(8, { timeout: 15000 });

    const tb = page.locator('[data-organize-toolbar]');
    await tb.getByRole('button', { name: '全选' }).click();
    await expect(page.locator('.page-card.selected')).toHaveCount(8);

    // 右转 90°：每页出现旋转标记
    await tb.getByRole('button', { name: '⟲ 右转90°' }).click();
    await expect(page.locator('.rotate-tag')).toHaveCount(8);

    // 点缩略图选中第 1 页后删除
    await cards.first().click();
    await tb.getByRole('button', { name: /删除所选/ }).click();
    await expect(cards).toHaveCount(7);
    await expect(cards.first().locator('.page-no')).toContainText('P2');

    // 撤销可用：恢复 8 页与旋转标记
    await tb.getByRole('button', { name: '↶ 撤销' }).click();
    await expect(cards).toHaveCount(8);
    await expect(page.locator('.rotate-tag')).toHaveCount(8);

    // 再次删除第 1 页
    await cards.first().click();
    await tb.getByRole('button', { name: /删除所选/ }).click();
    await expect(cards).toHaveCount(7);

    // HTML5 拖拽：第 2 张拖到第 1 张上 → 交换
    await cards.nth(1).dragTo(cards.first());
    await expect(cards.first().locator('.page-no')).toContainText('P3');
    await expect(cards.nth(1).locator('.page-no')).toContainText('P2');

    await page.getByRole('button', { name: '开始整理' }).click();
    await expect(page.getByText('整理完成：输出 7 页')).toBeVisible({ timeout: 30000 });
    const p = await saveDownload(page, '下载整理结果', 'organize-out.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('边界：无文件时开始禁用；删除全部页面后开始禁用', async ({ page }) => {
    const go = page.getByRole('button', { name: '开始整理' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi8.pdf'], false);
    await expect(page.locator('.page-card')).toHaveCount(8, { timeout: 15000 });
    await expect(go).toBeEnabled();

    const tb = page.locator('[data-organize-toolbar]');
    await tb.getByRole('button', { name: '全选' }).click();
    await tb.getByRole('button', { name: /删除所选/ }).click();
    await expect(page.locator('.page-card')).toHaveCount(0);
    await expect(go).toBeDisabled();
  });
});
