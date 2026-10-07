// 旋转/镜像工具 e2e：旋转 90°、左右/上下镜像、页范围镜像、参数错误链路
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('旋转/镜像 PDF 工具', () => {
  test.beforeEach(() => {
    ensureFixtures();
  });

  test('旋转 90°：multi3 全部页相对旋转 → 1 个产物', async ({ page }) => {
    await openTool(page, 'rotate');
    const go = page.getByRole('button', { name: '开始旋转' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('select[data-rot-angle]').selectOption('90');
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.kv b').first()).toContainText('页数 3');

    const p = await saveDownload(page, '下载', 'rotate-90.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('左右镜像：multi3 全部页 0°+水平翻转 → 1 个产物', async ({ page }) => {
    await openTool(page, 'rotate');
    await upload(page, ['multi3.pdf'], false);
    const go = page.getByRole('button', { name: '开始旋转' });
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('select[data-rot-angle]').selectOption('0');
    await page.getByRole('checkbox', { name: /左右镜像/ }).check();
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.kv b').first()).toContainText('镜像 左右');

    const p = await saveDownload(page, '下载', 'rotate-mirror-h.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('上下镜像：multi3 全部页 0°+垂直翻转 → 1 个产物', async ({ page }) => {
    await openTool(page, 'rotate');
    await upload(page, ['multi3.pdf'], false);
    const go = page.getByRole('button', { name: '开始旋转' });
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('select[data-rot-angle]').selectOption('0');
    await page.getByRole('checkbox', { name: /上下镜像/ }).check();
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.kv b').first()).toContainText('镜像 上下');

    const p = await saveDownload(page, '下载', 'rotate-mirror-v.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('上下镜像+页范围：multi3 仅第 2 页 → 1 个产物', async ({ page }) => {
    await openTool(page, 'rotate');
    await upload(page, ['multi3.pdf'], false);
    const go = page.getByRole('button', { name: '开始旋转' });
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('select[data-rot-angle]').selectOption('0');
    await page.locator('input[data-rot-pages]').fill('2');
    await page.getByRole('checkbox', { name: /上下镜像/ }).check();
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.kv b').first()).toContainText('页数 1');

    const p = await saveDownload(page, '下载', 'rotate-mirror-p2.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('参数错误：不旋转且不镜像 → 报错且无产物', async ({ page }) => {
    await openTool(page, 'rotate');
    await upload(page, ['multi3.pdf'], false);
    const go = page.getByRole('button', { name: '开始旋转' });
    await expect(go).toBeEnabled({ timeout: 15000 });
    await page.locator('select[data-rot-angle]').selectOption('0');
    await go.click();
    await expect(page.locator('[data-pc-err] .alert-error')).toContainText(
      '请选择旋转角度或镜像方式', { timeout: 15000 },
    );
    await expect(page.getByText('处理完成：1 个文件')).toHaveCount(0);
    // 修正后可正常执行（勾上镜像）
    await page.getByRole('checkbox', { name: /左右镜像/ }).check();
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
  });
});
