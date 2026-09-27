// 图片转 PDF e2e（subagent C）
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('图片转 PDF 工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'images2pdf');
  });

  test('上传→下移排序交换→A4 contain→执行→下载 PDF', async ({ page }) => {
    await upload(page, ['photo_l.jpg', 'alpha.png']);
    const items = page.locator('.img-item');
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText('photo_l.jpg');
    await expect(items.nth(1)).toContainText('alpha.png');

    // 下移按钮交换顺序
    await items.first().getByRole('button', { name: '下移' }).click();
    await expect(items.first()).toContainText('alpha.png');
    await expect(items.nth(1)).toContainText('photo_l.jpg');

    // A4 + contain（默认即 contain）
    await page.getByLabel('纸张', { exact: true }).selectOption('a4');
    await page.getByLabel('适应方式').selectOption('contain');

    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible();

    const p = await saveDownload(page, '下载 PDF', 'images2pdf-out.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('参数边界：无图片时开始禁用；非法背景色被拦截', async ({ page }) => {
    await expect(page.getByRole('button', { name: '开始转换' })).toBeDisabled();

    await upload(page, ['alpha.png']);
    await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled();

    // 非法背景色 → 不出产物、有错误提示
    await page.getByLabel('背景色（透明图片的底色）').fill('zzz');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect(page.locator('.result-artifact')).toHaveCount(0);
    await expect(page.getByText('转换完成')).toHaveCount(0);
  });
});
