// 「更多」页面/信息类工具 e2e（删除/提取/拼版/切半/裁剪/改尺寸/书签/文档信息/移除元数据/查看器偏好）
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('更多 · 页面/信息工具', () => {
  test.beforeEach(() => {
    ensureFixtures();
  });

  test('删除页面：multi3 删第 2 页 → 1 个产物（删除页数 1 · 剩余页数 2）', async ({ page }) => {
    await openTool(page, 'removepages');
    const go = page.getByRole('button', { name: '开始删除' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-rm-pages]').fill('2');
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/删除页数 1/)).toBeVisible();
    await expect(page.getByText(/剩余页数 2/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-remove.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('提取页面：multi3 提取 2-3 → 2 页产物', async ({ page }) => {
    await openTool(page, 'extractpages');
    const go = page.getByRole('button', { name: '开始提取' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-ex-pages]').fill('2-3');
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/页数 2/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-extract.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('每页页面数：multi8 前 4 页 4 合 1 → 1 张 A4', async ({ page }) => {
    await openTool(page, 'nup');
    const go = page.getByRole('button', { name: '开始拼版' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi8.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-nup-per]').selectOption('4');
    await page.locator('[data-nup-pages]').fill('1-4');
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/张数 1/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-nup.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('页面切半：multi3 左右切分 → 6 页产物', async ({ page }) => {
    await openTool(page, 'halve');
    const go = page.getByRole('button', { name: '开始切分' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await expect(page.locator('input[data-halve-dir="vertical"]')).toBeChecked();
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/页数 6/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-halve.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('裁剪：multi3 四边 50pt → 产物可下载', async ({ page }) => {
    await openTool(page, 'crop');
    const go = page.getByRole('button', { name: '开始裁剪' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-crop-left]').fill('50');
    await page.locator('[data-crop-top]').fill('50');
    await page.locator('[data-crop-right]').fill('50');
    await page.locator('[data-crop-bottom]').fill('50');
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/页数 3/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-crop.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('更改页面大小：multi3 → Letter（612×792）', async ({ page }) => {
    await openTool(page, 'resize');
    const go = page.getByRole('button', { name: '开始调整' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-rz-paper]').selectOption('letter');
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/纸张 LETTER/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-resize.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('添加书签：两行（顶级+子级）→ 2 条书签写入', async ({ page }) => {
    await openTool(page, 'bookmarks');
    const go = page.getByRole('button', { name: '开始添加' });
    const addBtn = page.getByRole('button', { name: '添加一行' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await page.locator('[data-bm-rows]').waitFor();
    await page.locator('[data-bm-row]').first().waitFor();

    // 第一行：顶级，第 1 页
    const row1 = page.locator('[data-bm-row]').nth(0);
    await row1.locator('[data-bm-title]').fill('第一章');
    await row1.locator('[data-bm-page]').fill('1');
    await expect(go).toBeEnabled();

    // 第二行：子级，第 2 页
    await addBtn.click();
    const row2 = page.locator('[data-bm-row]').nth(1);
    await row2.locator('[data-bm-title]').fill('第一节');
    await row2.locator('[data-bm-page]').fill('2');
    await row2.locator('[data-bm-level]').selectOption('1');

    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/书签数 2/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-bookmarks.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('修改文档信息：标题 + 作者 → 2 个字段写入', async ({ page }) => {
    await openTool(page, 'docinfo');
    const go = page.getByRole('button', { name: '开始修改' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-di-title]').fill('E2E 测试标题');
    await page.locator('[data-di-author]').fill('E2E Tester');
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/字段数 2/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-docinfo.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('移除元数据：需勾选确认后才可清除', async ({ page }) => {
    await openTool(page, 'metaclean');
    const go = page.getByRole('button', { name: '开始清除' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeDisabled(); // 未勾选确认仍禁用
    await page.locator('[data-mc-agree]').check();
    await expect(go).toBeEnabled();

    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });

    const p = await saveDownload(page, '下载', 'more-metaclean.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('查看器偏好：书签面板 + 隐藏工具栏 → 写入 PageMode', async ({ page }) => {
    await openTool(page, 'viewerpref');
    const go = page.getByRole('button', { name: '开始设置' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-vp-pagemode]').selectOption('UseOutlines');
    await page.locator('[data-vp-hidetoolbar]').check();
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });

    const p = await saveDownload(page, '下载', 'more-viewerpref.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('边界：裁剪边距非法 → 红字提示且开始禁用，不出产物', async ({ page }) => {
    await openTool(page, 'crop');
    const go = page.getByRole('button', { name: '开始裁剪' });

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });

    // 页宽 595pt：左边距 600 会把页面裁没 → 客户端校验拦截
    await page.locator('[data-crop-left]').fill('600');
    await expect(page.locator('[data-crop-err]')).toBeVisible();
    await expect(go).toBeDisabled();
    await expect(page.locator('.result-artifact')).toHaveCount(0);

    // 修正为合法值后恢复可用
    await page.locator('[data-crop-left]').fill('50');
    await expect(page.locator('[data-crop-err]')).toBeHidden();
    await expect(go).toBeEnabled();
  });

  test('边界：删除页码越界 → 引擎报错红字提示，不出产物；无文件时开始禁用', async ({ page }) => {
    await openTool(page, 'removepages');
    const go = page.getByRole('button', { name: '开始删除' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-rm-pages]').fill('9');
    await go.click();
    await expect(page.locator('.alert-error')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.result-artifact')).toHaveCount(0);
  });
});
