// 文件剪贴板 e2e：真实剪贴板写读往返（授予权限后走 OS 剪贴板）+ 粘贴事件 + 错误链路。
// 上传统一走真实 filechooser（helpers.upload）；paste 事件无 filechooser 通道，
// 以合成 ClipboardEvent 驱动 input.js 全局粘贴管线（浏览器真实事件路径）。
import { test, expect } from '@playwright/test';
import { openTool, upload, ensureFixtures } from './helpers.js';

test.beforeAll(() => ensureFixtures());

async function grantClipboard(page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
}

test.describe('文件剪贴板', () => {
  test('图片：PNG 复制 → 真实剪贴板 → 读取取回', async ({ page }) => {
    await grantClipboard(page);
    await openTool(page, 'clipboard-files');
    await expect(page.getByRole('button', { name: '复制到剪贴板' })).toBeDisabled();
    await upload(page, ['alpha.png']);
    await page.getByRole('button', { name: '复制到剪贴板' }).click();
    await expect(page.getByText('复制成功：1 个文件已进入系统剪贴板')).toBeVisible();

    await page.getByRole('button', { name: '读取剪贴板' }).click();
    await expect(page.locator('.file-list .tag')).toHaveCount(2);
    await expect(page.locator('.file-list .tag').nth(1)).toContainText('剪贴板-');
    await expect(page.getByText('已从剪贴板取到 1 个文件')).toBeVisible();
  });

  test('任意文件：txt 经 Web 自定义格式复制 → 读取取回', async ({ page }) => {
    await grantClipboard(page);
    await openTool(page, 'clipboard-files');
    await upload(page, ['sample.txt']);
    await page.getByRole('button', { name: '复制到剪贴板' }).click();
    await expect(page.getByText('复制成功：1 个文件已进入系统剪贴板')).toBeVisible();

    await page.getByRole('button', { name: '读取剪贴板' }).click();
    await expect(page.locator('.file-list .tag')).toHaveCount(2);
    await expect(page.locator('.file-list .tag').nth(1)).toContainText(/剪贴板-.*\.txt/);
  });

  test('粘贴事件：剪贴板文件经 paste 管线进入列表', async ({ page }) => {
    await openTool(page, 'clipboard-files');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'paste-e2e.bin', { type: 'application/octet-stream' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.file-list .tag')).toHaveCount(1);
    await expect(page.locator('.file-list .tag').first()).toContainText('paste-e2e.bin');
  });

  test('边界：clipboard.write 被拒 → 明确错误提示且无成功卡', async ({ page }) => {
    await grantClipboard(page);
    await openTool(page, 'clipboard-files');
    await upload(page, ['sample.txt']);
    await page.evaluate(() => {
      const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
      const real = desc ? desc.get.call(navigator) : null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          ...(real || {}),
          write: () => Promise.reject(new DOMException('Document is not focused', 'NotAllowedError')),
        },
      });
    });
    await page.getByRole('button', { name: '复制到剪贴板' }).click();
    await expect(page.getByText('复制失败')).toBeVisible();
    await expect(page.getByText(/Document is not focused/)).toBeVisible();
    await expect(page.getByText(/复制成功/)).toHaveCount(0);
    await expect(page.locator('.toast-error')).toHaveText('复制到剪贴板失败', { timeout: 5_000 });
  });
});
