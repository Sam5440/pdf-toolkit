// 暂存区持久化与文件夹 e2e：IndexedDB 跨刷新恢复、文件夹新建/移动/重命名/删除、
// 多图片产物自动归档文件夹、上传非 PDF 文件（markdown）也持久入架
import { test, expect } from '@playwright/test';
import { ensureFixtures, openTool, upload, FIXTURES } from './helpers.js';

test.describe('暂存区持久化与文件夹', () => {
  test.beforeEach(() => ensureFixtures());

  test('暂存内容跨刷新恢复（含来源标记「已恢复」）', async ({ page }) => {
    await openTool(page, 'viewer');
    await upload(page, ['multi3.pdf']);
    await expect(page.locator('.tray-rail [data-tray-item]')).toHaveCount(1);
    await page.reload();
    // 水合异步：恢复后出现，来源徽标为「已恢复」
    const rail = page.locator('.tray-rail');
    await expect(rail.locator('[data-tray-item]')).toHaveCount(1, { timeout: 15_000 });
    await expect(rail.locator('.badge', { hasText: '已恢复' })).toHaveCount(1);
    // 顶栏徽标同步
    await expect(page.locator('[data-tray-toggle] .tray-toggle-n')).toHaveText('1');
    // 恢复的文件可用：加入编辑区
    await openTool(page, 'merge');
    await rail.locator('[data-tray-item]').first().getByRole('button', { name: '加入' }).click();
    await expect(page.locator('.file-list .tag')).toHaveCount(1);
    await expect(page.locator('.file-list .tag')).toContainText('multi3.pdf');
  });

  test('文件夹：新建 → 拖动条目移入 → 跨刷新恢复 → 重命名 → 删除移回根', async ({ page }) => {
    await page.goto('/');
    const rail = page.locator('.tray-rail');
    // 直接给暂存区添加文件
    const chooserP = page.waitForEvent('filechooser');
    await rail.locator('[data-tray-upload]').click();
    (await chooserP).setFiles([`${FIXTURES}/multi3.pdf`]);
    await expect(rail.locator('[data-tray-item]')).toHaveCount(1);
    // 新建文件夹（行内输入，回车确认）
    await rail.locator('[data-tray-new-folder]').click();
    const input = rail.getByLabel('新建文件夹名称');
    await input.fill('归档');
    await input.press('Enter');
    const head = rail.locator('[data-tray-folder="归档"]');
    await expect(head).toBeVisible();
    // 下拉移动条目到文件夹（桌面端 select 悬浮显示，先悬停该行）
    await rail.locator('[data-tray-item]').first().hover();
    await rail.getByLabel('移动 multi3.pdf 到文件夹').selectOption('归档');
    await expect(head.locator('.badge')).toHaveText('1');
    await expect(rail.locator('[data-tray-item]')).toHaveCount(1); // 仍在架（只是换了分组）
    // 空根目录：根层无未分组条目（body 里只有文件夹分区）——渲染无异常即可
    // 跨刷新：文件夹与条目分组都恢复
    await page.reload();
    const head2 = page.locator('[data-tray-folder="归档"]');
    await expect(head2).toBeVisible({ timeout: 15_000 });
    await expect(head2.locator('.badge')).toHaveText('1');
    // 重命名（行内输入；操作按钮 hover 才显示，先悬停头部）
    await head2.hover();
    await head2.getByRole('button', { name: '重命名文件夹 归档' }).click();
    const ren = head2.getByRole('textbox', { name: '重命名文件夹 归档' });
    await ren.fill('归档2');
    await ren.press('Enter');
    const head3 = page.locator('[data-tray-folder="归档2"]');
    await expect(head3).toBeVisible();
    // 删除文件夹：条目移回根目录
    await head3.hover();
    await head3.getByRole('button', { name: '删除文件夹 归档2（文件移回根目录）' }).click();
    await page.locator('[data-cd-confirm]').click();
    await expect(page.locator('[data-tray-folder="归档2"]')).toHaveCount(0);
    await expect(page.locator('.tray-rail [data-tray-item]')).toHaveCount(1);
  });

  test('多图片产物自动归档到「工具 · 来源文档」文件夹（PDF 转图片）', async ({ page }) => {
    test.setTimeout(180_000);
    await openTool(page, 'pdf2images');
    await upload(page, ['multi3.pdf']);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText(/转换完成：3 张图片/)).toBeVisible({ timeout: 120_000 });
    const rail = page.locator('.tray-rail');
    // 3 页 → 3 张图片，全部挂在文件夹下；另有上传镜像的源 PDF 在根层
    const folderPath = 'PDF 转图片 · multi3';
    const head = rail.locator(`[data-tray-folder="${folderPath}"]`);
    await expect(head).toBeVisible();
    await expect(head.locator('.badge')).toHaveText('3');
    await expect(rail.locator('[data-tray-item]')).toHaveCount(4);
    // 产物按默认命名规则改名（原名-操作-…-页码.pdf），逐项区分段 p001-p003 保留
    await expect(rail.locator('.tray-folder-sec [data-tray-item] .ti-name')).toHaveText([
      /^multi3-.*-p001\.png$/, /^multi3-.*-p002\.png$/, /^multi3-.*-p003\.png$/,
    ]);
    await expect(rail.locator('.tray-body > .tray-list .ti-name')).toHaveText(['multi3.pdf']); // 根层仅源文件
    // 文件夹 ZIP 打包按钮存在（hover 展开）
    await head.hover();
    await expect(head.getByRole('button', { name: `打包下载文件夹 ${folderPath}` })).toBeVisible();
  });

  test('上传 markdown 等非 PDF 文件也入暂存区并持久化', async ({ page }) => {
    await openTool(page, 'md2pdf');
    await upload(page, ['rich.md'], false);
    const rail = page.locator('.tray-rail');
    await expect(rail.locator('.ti-name')).toHaveText(['rich.md']);
    await page.reload();
    await expect(rail.locator('.ti-name')).toHaveText(['rich.md'], { timeout: 15_000 });
    // 恢复的 md 可回填编辑器
    await rail.locator('[data-tray-item]').first().getByRole('button', { name: '加入' }).click();
    await expect(page.locator('.file-list .tag')).toContainText('rich.md');
  });
});
