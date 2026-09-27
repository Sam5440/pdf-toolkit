// PDF 叠加 e2e（代理 B）：底稿 + 覆盖稿真实上传 → 配对模式/参数 → 执行 → 下载
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { openTool, saveDownload, ensureFixtures, FIXTURES } from './helpers.js';

test.describe('overlay PDF叠加工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'overlay');
  });

  // 页面有两个 dropzone（底稿/覆盖稿），helpers.upload 只会点第一个 → 这里按面板定位
  // 仍然走真实 filechooser 路径（禁止 DOM 注入伪造上传）
  async function uploadTo(page, panelKey, file) {
    const chooserP = page.waitForEvent('filechooser');
    await page.locator(`[data-overlay-panel="${panelKey}"] .dropzone`).click();
    const chooser = await chooserP;
    await chooser.setFiles([path.join(FIXTURES, file)]);
    await page.waitForTimeout(400);
  }

  test('oneToOne 成功链路：执行 → 下载 overlay-out.pdf', async ({ page }) => {
    await uploadTo(page, 'base', 'multi3.pdf');
    await uploadTo(page, 'overlay', 'multi3.pdf');
    await expect(page.locator('[data-ov="hint"]')).toContainText('共 3 组', { timeout: 20000 });
    await page.waitForFunction(() => {
      const c = document.querySelector('[data-ov="baseCanvas"]');
      return c && c.width > 10;
    }, undefined, { timeout: 20000 });

    await page.locator('[data-ov="opacity"]').fill('50');
    await expect(page.locator('[data-ov="hint"]')).toContainText('50%');
    await page.getByRole('button', { name: '开始叠加' }).click();
    await expect(page.getByRole('button', { name: '下载叠加 PDF' })).toBeVisible({ timeout: 30000 });
    const dest = await saveDownload(page, '下载叠加 PDF', 'overlay-out.pdf');
    expect(fs.existsSync(dest)).toBeTruthy();
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '保存到历史' })).toBeVisible();
  });

  test('自定义配对：1:1 / 2:3 → 执行 → 下载', async ({ page }) => {
    await uploadTo(page, 'base', 'multi3.pdf');
    await uploadTo(page, 'overlay', 'multi3.pdf');
    await page.locator('[data-ov="mode"]').selectOption('custom');
    await page.locator('[data-ov="customRows"]').fill('1:1\n2:3');
    await expect(page.locator('[data-ov="hint"]')).toContainText('共 2 组', { timeout: 20000 });
    await page.getByRole('button', { name: '开始叠加' }).click();
    await expect(page.getByRole('button', { name: '下载叠加 PDF' })).toBeVisible({ timeout: 30000 });
    const dest = await saveDownload(page, '下载叠加 PDF', 'overlay-custom-out.pdf');
    expect(fs.existsSync(dest)).toBeTruthy();
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
  });

  test('参数错误：自定义配对格式非法 → 报错且无产物', async ({ page }) => {
    await uploadTo(page, 'base', 'multi3.pdf');
    await uploadTo(page, 'overlay', 'multi3.pdf');
    await expect(page.locator('[data-ov="hint"]')).toContainText('共 3 组', { timeout: 20000 });
    await page.locator('[data-ov="mode"]').selectOption('custom');
    await page.locator('[data-ov="customRows"]').fill('这不是合法配对');
    await page.getByRole('button', { name: '开始叠加' }).click();
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect(page.getByRole('button', { name: '下载叠加 PDF' })).toHaveCount(0);
  });
});
