// 右侧暂存区 e2e：上传镜像（PDF+图片全类型）、生成结果入架、拖拽到左侧、加入回填、
// 列表/封面双视图、单件与一键预览全部、清空确认、直接在暂存区上传
// 持久化与文件夹的专项用例见 tray-persist.spec.js
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { ensureFixtures, openTool, upload, FIXTURES } from './helpers.js';

test.describe('PDF 暂存区', () => {
  test.beforeEach(async ({ page }) => {
    ensureFixtures();
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.removeItem('pdftoolkit.tray.view');
      document.body.classList.remove('tray-collapsed', 'tray-open');
    });
  });

  test('上传 PDF 与图片都自动镜像到暂存区，切换工具持久', async ({ page }) => {
    await openTool(page, 'merge');
    await upload(page, ['multi3.pdf', 'photo_l.jpg']);
    const rail = page.locator('.tray-rail');
    await expect(rail.locator('[data-tray-item]')).toHaveCount(2);
    await expect(rail.locator('.ti-name')).toHaveText(['multi3.pdf', 'photo_l.jpg']);
    await expect(rail.locator('.badge', { hasText: '上传' })).toHaveCount(2);
    // 顶栏开关按钮的数量徽标
    await expect(page.locator('[data-tray-toggle] .tray-toggle-n')).toHaveText('2');
    // 切换工具（hash 导航不重载页面，内存态文档架保留）
    await page.locator('a.side-link[href="#/tool/compress"]').click();
    await page.waitForTimeout(250);
    await expect(page.locator('.tray-rail [data-tray-item]')).toHaveCount(2);
    await expect(page.locator('.tray-rail .ti-name')).toHaveText(['multi3.pdf', 'photo_l.jpg']);
  });

  test('生成结果自动入暂存区；「加入」回填左侧编辑区', async ({ page }) => {
    await openTool(page, 'merge');
    await upload(page, ['multi3.pdf']);
    await page.getByRole('button', { name: '开始合并' }).click();
    await expect(page.getByText('合并完成')).toBeVisible();
    const rail = page.locator('.tray-rail');
    // 上传 1 + 生成 1
    await expect(rail.locator('[data-tray-item]')).toHaveCount(2);
    await expect(rail.locator('.badge', { hasText: '生成' })).toHaveCount(1);
    // 生成的合并结果回填左侧编辑区（同一 PDF 不在暂存区产生重复）
    const genRow = rail.locator('[data-tray-item]').filter({ hasText: /multi3-合并-\d{8}-\d{4}\.pdf/ });
    await genRow.getByRole('button', { name: '加入' }).click();
    await expect(page.locator('.file-list .tag')).toHaveCount(2);
    await expect(rail.locator('[data-tray-item]')).toHaveCount(2);
  });

  test('从暂存区拖拽 PDF 到左侧上传区进行编辑选取，且不产生重复副本', async ({ page }) => {
    await openTool(page, 'split');
    await upload(page, ['multi3.pdf']);
    // 从左侧编辑列表移除，暂存区副本应保留
    await page.locator('.file-list .tag .t-x').first().click();
    await expect(page.locator('.file-list .tag')).toHaveCount(0);
    await expect(page.locator('.tray-rail [data-tray-item]')).toHaveCount(1);
    // HTML5 拖拽：暂存项 → dropzone
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await page.locator('.tray-item').first().dispatchEvent('dragstart', { dataTransfer: dt });
    await page.locator('.dropzone').first().dispatchEvent('drop', { dataTransfer: dt });
    await expect(page.locator('.file-list .tag')).toHaveCount(1);
    await expect(page.locator('.file-list .tag')).toContainText('multi3.pdf');
    // 同一文件拖回编辑区不在暂存区产生第二份
    await expect(page.locator('.tray-rail [data-tray-item]')).toHaveCount(1);
  });

  test('封面视图渲染首页缩略图，视图选择与暂存内容均跨刷新保留', async ({ page }) => {
    await openTool(page, 'viewer');
    await upload(page, ['multi3.pdf']);
    const rail = page.locator('.tray-rail');
    await rail.getByRole('button', { name: '封面' }).click();
    const card = rail.locator('.tray-card');
    await expect(card).toHaveCount(1);
    // 封面为真实渲染的首页缩略图（引擎 doc.render → webp dataURL）
    await expect(card.locator('.tray-cover img')).toHaveCount(1, { timeout: 20_000 });
    // 刷新后暂存内容经 IndexedDB 恢复（持久化），视图选择保留
    await page.reload();
    await expect(page.locator('.tray-rail .tray-card')).toHaveCount(1, { timeout: 15_000 });
    await upload(page, ['multi8.pdf']);
    await expect(page.locator('.tray-rail .tray-card')).toHaveCount(2);
    // 切回列表视图
    await page.locator('.tray-rail').getByRole('button', { name: '列表' }).click();
    await expect(page.locator('.tray-rail .tray-item')).toHaveCount(2);
  });

  test('单件预览：点击暂存项直接打开该 PDF', async ({ page }) => {
    await openTool(page, 'viewer');
    await upload(page, ['multi3.pdf']);
    await page.locator('.tray-item').first().click();
    await expect(page.locator('.pv-wrap')).toBeVisible();
    await expect(page.locator('.pv-doc')).toHaveCount(1);
    await expect(page.locator('.pv-canvas').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.pv-page-no').first()).toContainText('第 1 / 3 页');
    await page.locator('.modal-head button').click();
    await expect(page.locator('.pv-wrap')).toHaveCount(0);
  });

  test('一键预览全部：文档列表可切换，页画布懒渲染', async ({ page }) => {
    await openTool(page, 'merge');
    await upload(page, ['multi3.pdf']);
    await page.getByRole('button', { name: '开始合并' }).click();
    await expect(page.getByText('合并完成')).toBeVisible();
    await page.locator('[data-tray-preview-all]').click();
    await expect(page.locator('.pv-wrap')).toBeVisible();
    await expect(page.locator('.pv-doc')).toHaveCount(2);
    await expect(page.locator('.modal-head')).toContainText('预览 1/2');
    await expect(page.locator('.pv-canvas').first()).toBeVisible({ timeout: 20_000 });
    // 切换到第二个文档（合并结果）
    await page.locator('.pv-doc').nth(1).click();
    await expect(page.locator('.modal-head')).toContainText('预览 2/2');
    await expect(page.locator('.pv-canvas').first()).toBeVisible({ timeout: 20_000 });
    // Esc 关闭
    await page.keyboard.press('Escape');
    await expect(page.locator('.pv-wrap')).toHaveCount(0);
  });

  test('图片暂存项可直接预览（不走 PDF 分页渲染）', async ({ page }) => {
    await page.goto('/');
    const rail = page.locator('.tray-rail');
    const chooserP = page.waitForEvent('filechooser');
    await rail.locator('[data-tray-upload]').click();
    (await chooserP).setFiles([path.join(FIXTURES, 'photo_l.jpg')]);
    await expect(rail.locator('[data-tray-item]')).toHaveCount(1);
    await rail.locator('.tray-item').first().click();
    await expect(page.locator('.pv-wrap')).toBeVisible();
    await expect(page.locator('.pv-img')).toBeVisible();
    await expect(page.locator('.pv-img')).toHaveAttribute('alt', 'photo_l.jpg');
  });

  test('清空需确认；左侧编辑区文件不受影响；顶栏开关可收起面板', async ({ page }) => {
    await openTool(page, 'merge');
    await upload(page, ['multi3.pdf']);
    await page.locator('.tray-foot').getByRole('button', { name: '移除暂存区全部文件' }).click();
    // 应用内 shadcn AlertDialog 确认（原生 confirm 已移除）
    await page.locator('[data-cd-confirm]').click();
    await expect(page.locator('.tray-rail .tray-empty')).toBeVisible();
    await expect(page.locator('.file-list .tag')).toHaveCount(1);
    // 顶栏开关收起/展开右侧栏
    await page.locator('[data-tray-toggle]').click();
    await expect(page.locator('.tray-rail')).toBeHidden();
    await page.locator('[data-tray-toggle]').click();
    await expect(page.locator('.tray-rail')).toBeVisible();
  });

  test('直接在暂存区上传：按钮走真实文件选择入架，全类型接受', async ({ page }) => {
    // 无需进入工具页：首页即可直接给暂存区添加文件
    const rail = page.locator('.tray-rail');
    await expect(rail.locator('[data-tray-upload]')).toBeEnabled();
    // 空架时预览/加入置灰
    await expect(rail.getByRole('button', { name: '一键预览暂存区全部文件' })).toBeDisabled();
    const chooserP = page.waitForEvent('filechooser');
    await rail.locator('[data-tray-upload]').click();
    const chooser = await chooserP;
    await chooser.setFiles([path.join(FIXTURES, 'multi3.pdf'), path.join(FIXTURES, 'photo_l.jpg')]);
    await expect(rail.locator('[data-tray-item]')).toHaveCount(2);
    await expect(rail.locator('.ti-name')).toHaveText(['multi3.pdf', 'photo_l.jpg']);
    await expect(page.locator('[data-tray-toggle] .tray-toggle-n')).toHaveText('2');
    // 入架后预览/加入恢复可用；同一文件再次加入不重复
    await expect(rail.getByRole('button', { name: '一键预览暂存区全部文件' })).toBeEnabled();
    const chooserP2 = page.waitForEvent('filechooser');
    await rail.locator('[data-tray-upload]').click();
    (await chooserP2).setFiles([path.join(FIXTURES, 'multi3.pdf')]);
    await expect(rail.locator('[data-tray-item]')).toHaveCount(2);
  });

  test('暂存区空态可点击上传；外部文件拖入面板直接入架', async ({ page }) => {
    const rail = page.locator('.tray-rail');
    // 空态整块是一个上传入口（点击打开真实文件选择器）
    const empty = rail.locator('[data-tray-empty]');
    await expect(empty).toBeVisible();
    const chooserP = page.waitForEvent('filechooser');
    await empty.click();
    (await chooserP).setFiles([path.join(FIXTURES, 'multi3.pdf')]);
    await expect(rail.locator('[data-tray-item]')).toHaveCount(1);
    // 清空回到空态
    await rail.getByRole('button', { name: '移除暂存区全部文件' }).click();
    await page.locator('[data-cd-confirm]').click();
    await expect(empty).toBeVisible();
    // 外部文件拖入面板：合成 DataTransfer 仅测事件接线（真实上传路径已由上方 filechooser 用例覆盖）
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'dropped.pdf', { type: 'application/pdf' }));
      return d;
    });
    await rail.dispatchEvent('dragenter', { dataTransfer: dt });
    await expect(rail).toHaveClass(/tray-drag/);
    await rail.dispatchEvent('drop', { dataTransfer: dt });
    await expect(rail.locator('[data-tray-item]')).toHaveCount(1);
    await expect(rail.locator('.ti-name')).toHaveText('dropped.pdf');
    await expect(rail).not.toHaveClass(/tray-drag/);
  });

  test('移动端抽屉：滑入开合，幕布点击与 Esc 均可收起', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const rail = page.locator('.tray-rail');
    const backdrop = page.locator('.tray-backdrop');
    await page.locator('[data-tray-toggle]').click();
    await expect(rail).toBeVisible();
    await expect(backdrop).toBeVisible();
    // 点击幕布收起
    await backdrop.click({ position: { x: 20, y: 300 } });
    await expect(rail).toBeHidden();
    await expect(backdrop).toBeHidden();
    // 再开 → Esc 收起
    await page.locator('[data-tray-toggle]').click();
    await expect(rail).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rail).toBeHidden();
  });
});
