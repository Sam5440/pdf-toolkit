// PDF 比较 e2e（subagent C）
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { ensureFixtures, openTool, saveDownload, FIXTURES } from './helpers.js';

/** 向指定槽位上传（真实 filechooser）。页面有两个 .dropzone，不能用共享 upload()（会 strict violation） */
async function uploadToSlot(page, slot, files) {
  const chooserP = page.waitForEvent('filechooser');
  await page.locator(`[data-cmp-slot="${slot}"] .dropzone`).click();
  const chooser = await chooserP;
  await chooser.setFiles(files.map((f) => (path.isAbsolute(f) ? f : path.join(FIXTURES, f))));
  await page.waitForTimeout(400);
}

test.describe('PDF 比较工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'compare');
  });

  test('相同文件比较：3 对全部相同', async ({ page }) => {
    await uploadToSlot(page, 'A', ['multi3.pdf']);
    await uploadToSlot(page, 'B', ['multi3.pdf']);
    await expect(page.locator('[data-cmp-slot="A"]')).toContainText('共 3 页');
    await expect(page.locator('[data-cmp-slot="B"]')).toContainText('共 3 页');

    await page.getByRole('button', { name: '开始比较' }).click();
    const summary = page.locator('.cmp-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('总页对数 3');
    await expect(summary).toContainText('相同 3');
    await expect(summary).toContainText('差异 0');
    await expect(page.locator('.cmp-textdiffs')).toContainText('文本内容无差异');
  });

  test('multi3 vs multi8：页数不同→B 多出 5 页', async ({ page }) => {
    await uploadToSlot(page, 'A', ['multi3.pdf']);
    await uploadToSlot(page, 'B', ['multi8.pdf']);
    await expect(page.locator('[data-cmp-slot="B"]')).toContainText('共 8 页');

    await page.getByRole('button', { name: '开始比较' }).click();
    const summary = page.locator('.cmp-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('总页对数 3');
    await expect(summary).toContainText('B 多出 5 页');
    await expect(summary).toContainText('第 8 页');
  });

  test('内容不同的文件：差异页高亮图 ZIP 导出', async ({ page }) => {
    await uploadToSlot(page, 'A', ['smask_alpha.pdf']);
    await uploadToSlot(page, 'B', ['scan2.pdf']);

    await page.getByRole('button', { name: '开始比较' }).click();
    const summary = page.locator('.cmp-summary');
    await expect(summary).toBeVisible();
    // 两文件内容完全不同 → 至少 1 个差异页
    await expect(summary).toContainText(/差异 [1-9]/);

    const p = await saveDownload(page, '打包差异页高亮图 (.zip)', 'compare-diffs.zip');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('参数错误：未选择文件 B→错误提示不出结果', async ({ page }) => {
    await uploadToSlot(page, 'A', ['multi3.pdf']);
    await page.getByRole('button', { name: '开始比较' }).click();
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect(page.locator('.cmp-summary')).toHaveCount(0);
  });
});
