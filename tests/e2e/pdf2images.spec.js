// PDF 转图片 e2e（subagent C）
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('PDF 转图片工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'pdf2images');
  });

  test('multi3.pdf→范围1-2→PNG 150DPI→2 个产物→ZIP 下载', async ({ page }) => {
    await upload(page, ['multi3.pdf']);
    // 页数就绪后显示全部页 chip
    await expect(page.getByText('全部 3 页')).toBeVisible();

    // 页范围实时解析预览
    await page.getByPlaceholder('如 1-3,5（留空=全部页）').fill('1-2');
    await expect(page.getByText('共 2 页')).toBeVisible();
    await expect(page.getByText('第1页', { exact: true })).toBeVisible();
    await expect(page.getByText('第2页', { exact: true })).toBeVisible();

    // PNG 150DPI（默认值）
    await page.getByLabel('格式').selectOption('png');
    await page.getByLabel('DPI（72-300）').fill('150');

    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible();
    await expect(page.locator('.result-artifact')).toHaveCount(2);

    const p = await saveDownload(page, 'ZIP 打包下载', 'pdf2images.zip');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('downscaled_img.pdf→大图缩小渲染→1 个产物', async ({ page }) => {
    // 回归：大图绘制到小区域触发 pdf.js 临时 canvas 缩放路径，
    // Worker 里无 document，曾报 "Cannot read properties of undefined (reading 'createElement')"
    await upload(page, ['downscaled_img.pdf']);
    await expect(page.getByText('全部 1 页')).toBeVisible();

    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible();
    await expect(page.locator('.result-artifact')).toHaveCount(1);
  });

  test('tiling_pattern.pdf→平铺图案渲染→1 个产物', async ({ page }) => {
    // 回归：TilingPattern 渲染走同一 canvasFactory 临时 canvas 路径（同上崩溃类）
    await upload(page, ['tiling_pattern.pdf']);
    await expect(page.getByText('全部 1 页')).toBeVisible();

    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible();
    await expect(page.locator('.result-artifact')).toHaveCount(1);
  });

  test('参数错误：页码超出范围→引擎报错不出产物', async ({ page }) => {
    await upload(page, ['multi3.pdf']);
    await expect(page.getByText('全部 3 页')).toBeVisible();

    await page.getByPlaceholder('如 1-3,5（留空=全部页）').fill('99');
    await expect(page.getByText('页码 99 超出页数（1-3）')).toBeVisible();

    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.locator('.alert-error')).toBeVisible();
    await expect(page.locator('.result-artifact')).toHaveCount(0);
  });
});
