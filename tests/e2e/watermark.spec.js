// 添加水印 e2e（代理 B）：真实上传 → 编辑器真实预览 → 应用 → 下载 → 预设往返
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { openTool, upload, saveDownload, ensureFixtures, FIXTURES } from './helpers.js';

test.describe('watermark 添加水印工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'watermark');
  });

  // 等待真实预览（wm.preview，与导出同一绘制代码）完成
  async function waitReady(page, timeout = 20000) {
    await expect(page.locator('.wm-status')).toHaveAttribute('data-state', 'ready', { timeout });
  }

  // 预览 canvas 像素校验和（用于断言"非默认渲染"）
  async function canvasChecksum(page) {
    return page.evaluate(() => {
      const c = document.querySelector('[data-wm="previewCanvas"]');
      if (!c || !c.width) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4 * 97) {
        s = (s + d[i] * 31 + d[i + 1] * 17 + d[i + 2]) % 2147483647;
      }
      return s;
    });
  }

  test('文字水印成功链路：真实预览渲染 → 应用 → 下载', async ({ page }) => {
    await upload(page, ['multi3.pdf'], false);
    await expect(page.locator('[data-wm="previewCanvas"]')).toBeVisible();
    await waitReady(page);
    const baseline = await canvasChecksum(page);
    expect(baseline).toBeGreaterThanOrEqual(0);

    // 添加文字层并设置参数（含模板变量 / 平铺 / 交错）
    await page.getByRole('button', { name: '添加文字层' }).click();
    const ta = page.locator('[data-wm="text"]');
    await ta.waitFor();
    await ta.fill('绝密 {页码}');
    await page.locator('[data-wm="fontSize"]').fill('60');
    await page.locator('[data-wm="opacity"]').fill('40');
    await page.locator('input[data-wm="placement"][value="tile"]').check();
    await page.locator('[data-wm="stagger"]').check();

    // 等待新一轮真实预览完成，且与空预览不同（非默认渲染）
    await waitReady(page);
    await expect.poll(async () => canvasChecksum(page), { timeout: 15000 }).not.toBe(baseline);

    // 应用水印 → 结果卡 → 下载
    const applyBtn = page.getByRole('button', { name: '应用水印' });
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();
    await expect(page.getByRole('button', { name: '下载水印 PDF' })).toBeVisible({ timeout: 30000 });
    const dest = await saveDownload(page, '下载水印 PDF', 'watermark-out.pdf');
    expect(fs.existsSync(dest)).toBeTruthy();
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
    // UI 状态流转：结果卡出现、历史按钮出现、开始按钮恢复可用
    await expect(page.getByRole('button', { name: '保存到历史' })).toBeVisible();
    await expect(applyBtn).toBeEnabled();
  });

  test('拖动画布改变位置：草稿反馈 → 松手后触发新真实预览', async ({ page }) => {
    await upload(page, ['multi3.pdf'], false);
    await waitReady(page);
    await page.getByRole('button', { name: '添加文字层' }).click();
    await page.locator('[data-wm="text"]').waitFor();
    await waitReady(page);

    const offX = page.locator('[data-wm="offsetX"]');
    await expect(offX).toHaveValue('0');
    const canvas = page.locator('[data-wm="previewCanvas"]');
    await canvas.scrollIntoViewIfNeeded(); // 画布高于视口，中心点可能超出 720p 视口
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = Math.min(Math.max(box.y + box.height / 2, 120), 650); // 取视口内的画布点
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 90, cy + 60, { steps: 6 });
    await expect(page.locator('.wm-status')).toHaveAttribute('data-state', 'draft');
    await page.mouse.up();
    await expect(offX).not.toHaveValue('0');
    // 松手后立即触发新一轮真实预览并回到就绪
    await waitReady(page);
  });

  test('参数错误：清空文字 → 预览失败提示，应用被拦截且无产物', async ({ page }) => {
    await upload(page, ['multi3.pdf'], false);
    await waitReady(page);
    await page.getByRole('button', { name: '添加文字层' }).click();
    const ta = page.locator('[data-wm="text"]');
    await ta.waitFor();
    await ta.fill('   ');
    await expect(page.locator('.wm-status')).toHaveAttribute('data-state', 'error', { timeout: 10000 });
    await expect(page.locator('.wm-status')).toContainText('文字水印内容不能为空');

    await page.getByRole('button', { name: '应用水印' }).click();
    await expect(page.locator('.alert-error')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: '下载水印 PDF' })).toHaveCount(0);
  });

  test('图片水印：选择 alpha.png → 预览 → 应用 → 下载', async ({ page }) => {
    await upload(page, ['multi3.pdf'], false);
    await waitReady(page);
    await page.getByRole('button', { name: '添加图片层' }).click();
    const chooserP = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '选择图片', exact: true }).click();
    const chooser = await chooserP;
    await chooser.setFiles([path.join(FIXTURES, 'alpha.png')]);
    await expect(page.locator('[data-wm="imageName"]')).toContainText('alpha.png');
    await waitReady(page);
    await page.getByRole('button', { name: '应用水印' }).click();
    await expect(page.getByRole('button', { name: '下载水印 PDF' })).toBeVisible({ timeout: 30000 });
    const dest = await saveDownload(page, '下载水印 PDF', 'watermark-image-out.pdf');
    expect(fs.existsSync(dest)).toBeTruthy();
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
  });

  test('旋转页文档 rotated90.pdf 正常加水印', async ({ page }) => {
    await upload(page, ['rotated90.pdf'], false);
    await waitReady(page);
    await page.getByRole('button', { name: '添加文字层' }).click();
    await page.locator('[data-wm="text"]').waitFor();
    await page.locator('[data-wm="text"]').fill('绝密');
    await page.locator('[data-wm="rotation"]').fill('45');
    await waitReady(page);
    await page.getByRole('button', { name: '应用水印' }).click();
    await expect(page.getByRole('button', { name: '下载水印 PDF' })).toBeVisible({ timeout: 30000 });
    const dest = await saveDownload(page, '下载水印 PDF', 'watermark-rotated-out.pdf');
    expect(fs.existsSync(dest)).toBeTruthy();
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
  });

  test('预设：保存 → 刷新页面 → 载入还原 spec', async ({ page }) => {
    await upload(page, ['multi3.pdf'], false);
    await waitReady(page);
    await page.getByRole('button', { name: '添加文字层' }).click();
    await page.locator('[data-wm="text"]').waitFor();
    await page.locator('[data-wm="text"]').fill('预设测试文本');
    await page.locator('[data-wm="fontSize"]').fill('77');
    await page.locator('[data-wm="presetName"]').fill('测试预设A');
    await page.getByRole('button', { name: '保存预设' }).click();
    await expect(page.locator('.toast')).toContainText('已保存');

    // 刷新页面（重新进入工具）后重新上传文件，再载入预设 → spec 还原
    await openTool(page, 'watermark');
    await upload(page, ['multi3.pdf'], false);
    await waitReady(page);
    await page.locator('[data-wm="presetSelect"]').selectOption({ label: '测试预设A' });
    await page.getByRole('button', { name: '载入', exact: true }).click();
    await expect(page.locator('[data-wm="text"]')).toHaveValue('预设测试文本');
    await expect(page.locator('[data-wm="fontSize"]')).toHaveValue('77');
    await waitReady(page);
  });
});
