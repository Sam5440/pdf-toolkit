// 页面编辑 e2e（subagent A）
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('页面编辑工具', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await openTool(page, 'edit');
  });

  test('添加文字（测试水印文字）+高亮 → 拖动文字 → 执行 → 下载', async ({ page }) => {
    await upload(page, ['multi3.pdf'], false);
    await expect(page.locator('[data-edit="canvas"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-edit="pageLabel"]')).toContainText('第 1 / 3 页');

    // 弹窗添加文字框
    await page.getByRole('button', { name: '文字框' }).click();
    const ta = page.locator('textarea[data-edit="textArea"]');
    await ta.waitFor();
    await ta.fill('测试水印文字');
    await page.locator('.modal-box').getByRole('button', { name: '添加' }).click();
    const textObj = page.locator('.edit-obj[data-type="text"]');
    await expect(textObj).toContainText('测试水印文字');

    // 添加高亮矩形
    await page.getByRole('button', { name: '高亮矩形' }).click();
    await expect(page.locator('.edit-obj[data-type="highlight"]')).toHaveCount(1);

    // 拖动文字对象（mousedown/mousemove/mouseup）
    const beforeX = await textObj.getAttribute('data-x');
    const box = await textObj.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
    await expect(textObj).not.toHaveAttribute('data-x', beforeX);

    // 执行 → 结果卡 → 下载
    await page.getByRole('button', { name: '开始编辑' }).click();
    await expect(page.getByText('编辑完成')).toBeVisible({ timeout: 30000 });
    const p = await saveDownload(page, '下载编辑结果', 'edit-out.pdf');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('边界：无文件禁用；无对象时 toast 错误；Delete 键删除所选', async ({ page }) => {
    const go = page.getByRole('button', { name: '开始编辑' });
    await expect(go).toBeDisabled();

    await upload(page, ['multi3.pdf'], false);
    await expect(page.locator('[data-edit="canvas"]')).toBeVisible({ timeout: 15000 });
    await expect(go).toBeEnabled();

    // 无对象 → toast 错误，不出产物
    await go.click();
    await expect(page.locator('.toast-error')).toBeVisible();
    await expect(page.locator('.result-artifact')).toHaveCount(0);

    // 添加矩形（自动选中）→ Delete 键删除
    await page.getByRole('button', { name: '矩形', exact: true }).click();
    await expect(page.locator('.edit-obj[data-type="rect"]')).toHaveCount(1);
    await page.keyboard.press('Delete');
    await expect(page.locator('.edit-obj')).toHaveCount(0);
  });
});
