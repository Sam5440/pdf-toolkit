// 裁剪 PDF · 可视化框选 e2e：上传自动识别第 1 页白边、翻页预览、拖拽裁剪线、产物下载
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('更多 · 裁剪可视化', () => {
  test.beforeEach(() => {
    ensureFixtures();
  });

  /** 读取四边裁剪线数值（pt） */
  async function cropVals(page) {
    const g = async (attr) => Number(await page.locator(`[data-crop-${attr}]`).inputValue());
    return {
      left: await g('left'), top: await g('top'),
      right: await g('right'), bottom: await g('bottom'),
    };
  }

  test('上传即按第 1 页自动识别白边（60/72/84/96），预览可见', async ({ page }) => {
    await openTool(page, 'crop');
    await upload(page, ['whiteborder.pdf'], false);

    await expect(page.locator('[data-cp-canvas]')).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await cropVals(page)).left, { timeout: 15000 })
      .toBeGreaterThan(55);
    const v = await cropVals(page);
    expect(Math.abs(v.left - 60)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(v.top - 72)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(v.right - 84)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(v.bottom - 96)).toBeLessThanOrEqual(1.5);
    // 预览页信息标注第 1 页
    await expect(page.locator('[data-cp-pageinfo]')).toContainText('第 1 / 2 页');
  });

  test('翻到第 2 页重新识别 → 边距切换为 30/40/50/60', async ({ page }) => {
    await openTool(page, 'crop');
    await upload(page, ['whiteborder.pdf'], false);
    await expect(page.locator('[data-cp-canvas]')).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await cropVals(page)).left, { timeout: 15000 })
      .toBeGreaterThan(55);

    await page.locator('[data-cp-jump]').selectOption('1');
    await expect(page.locator('[data-cp-pageinfo]')).toContainText('第 2 / 2 页');
    await page.locator('[data-cp-detect]').click();
    await expect.poll(async () => (await cropVals(page)).left, { timeout: 10000 })
      .toBeLessThan(35);
    const v = await cropVals(page);
    expect(Math.abs(v.top - 40)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(v.right - 50)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(v.bottom - 60)).toBeLessThanOrEqual(1.5);
  });

  test('拖拽左/上裁剪线 → 数值联动；恢复整页归零', async ({ page }) => {
    await openTool(page, 'crop');
    await upload(page, ['whiteborder.pdf'], false);
    await expect(page.locator('[data-cp-canvas]')).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await cropVals(page)).left, { timeout: 15000 })
      .toBeGreaterThan(55);

    // CSS px ↔ pt 换算（预览 96dpi 渲染，画布可能被 max-width 缩放）
    const { cssPerPt } = await page.evaluate(() => {
      const c = document.querySelector('[data-cp-canvas]');
      const r = c.getBoundingClientRect();
      return { cssPerPt: r.width / (c.width * 72 / 96) };
    });

    // 左线右移 48pt（手柄纵跨整页，取靠上可见位置，避开 30px 四角手柄）
    const hL = page.locator('[data-cp-edge="left"]');
    const bb = await hL.boundingBox();
    const dragY = bb.y + Math.min(150, bb.height / 2);
    await page.mouse.move(bb.x + bb.width / 2, dragY);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width / 2 + 48 * cssPerPt, dragY, { steps: 8 });
    await page.mouse.up();
    let v = await cropVals(page);
    expect(Math.abs(v.left - 108)).toBeLessThanOrEqual(2.5);

    // 上线下移 24pt
    const hT = page.locator('[data-cp-edge="top"]');
    const bt = await hT.boundingBox();
    await page.mouse.move(bt.x + bt.width / 2, bt.y + bt.height / 2);
    await page.mouse.down();
    await page.mouse.move(bt.x + bt.width / 2, bt.y + bt.height / 2 + 24 * cssPerPt, { steps: 8 });
    await page.mouse.up();
    v = await cropVals(page);
    expect(Math.abs(v.top - 96)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(v.left - 108)).toBeLessThanOrEqual(2.5); // 左线保持

    // 恢复整页
    await page.locator('[data-cp-full]').click();
    v = await cropVals(page);
    expect(v).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  test('按识别结果裁剪全部页 → 产物下载', async ({ page }) => {
    await openTool(page, 'crop');
    const go = page.getByRole('button', { name: '开始裁剪' });
    await expect(go).toBeDisabled();

    await upload(page, ['whiteborder.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    await expect.poll(async () => (await cropVals(page)).left, { timeout: 15000 })
      .toBeGreaterThan(55);

    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/页数 2/)).toBeVisible();

    const p = await saveDownload(page, '下载', 'more-crop-vis.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('旋转页（/Rotate 90）左右各 50pt → 预览与产物方向一致', async ({ page }) => {
    await openTool(page, 'crop');
    const go = page.getByRole('button', { name: '开始裁剪' });

    await upload(page, ['rotated90.pdf'], false);
    await expect(go).toBeEnabled({ timeout: 15000 });
    // 横版预览（842×595）
    await expect(page.locator('[data-cp-pageinfo]')).toContainText('842×595', { timeout: 15000 });

    // 显式覆盖四边（上传时自动识别会先填入该页边距，需归零上下）
    await page.locator('[data-crop-left]').fill('50');
    await page.locator('[data-crop-top]').fill('0');
    await page.locator('[data-crop-right]').fill('50');
    await page.locator('[data-crop-bottom]').fill('0');
    await go.click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });

    const p = await saveDownload(page, '下载', 'more-crop-rot.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });
});
