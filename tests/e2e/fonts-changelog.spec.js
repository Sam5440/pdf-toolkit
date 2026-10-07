// 设置面板 e2e：外挂字体（上传真实 TTF → 家族名解析入列表 → 删除；远程 URL 同步失败/清空）
// + 关于（版本号/构建 commit + 查看更新日志：含提交时间的提交列表）
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { ensureFixtures, FIXTURES } from './helpers.js';

async function openSettings(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.modal-box')).toBeVisible();
}

test.describe('设置：外挂字体', () => {
  test.beforeEach(() => ensureFixtures());

  test('上传真实 TTF → 列表显示（家族名/文件名/大小/来源）→ 删除', async ({ page }) => {
    await openSettings(page);
    const list = page.locator('.userfont-list');
    await expect(list).toContainText('尚未安装外挂字体');
    // 真实 filechooser 上传（禁止 DOM 注入）
    const chooserP = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传外挂字体文件' }).click();
    const chooser = await chooserP;
    await chooser.setFiles([path.join(FIXTURES, 'testfont.ttf')]);
    await expect(page.locator('.userfont-row')).toHaveCount(1);
    // 家族名解析自字体 name 表（Noto 子集家族名以 Noto 开头且非空）
    await expect(page.locator('.userfont-row .uf-name')).toHaveText(/\S+/);
    await expect(page.locator('.userfont-row .uf-meta')).toContainText('testfont');
    await expect(page.locator('.userfont-row .uf-meta')).toContainText('本地上传');
    // 删除
    await page.getByRole('button', { name: /删除外挂字体/ }).click();
    await expect(list).toContainText('尚未安装外挂字体');
  });

  test('拒绝非字体扩展（错误提示），列表不变', async ({ page }) => {
    await openSettings(page);
    const chooserP = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传外挂字体文件' }).click();
    const chooser = await chooserP;
    await chooser.setFiles([path.join(FIXTURES, 'sample.txt')]);
    await expect(page.locator('.userfont-row')).toHaveCount(0);
    await expect(page.locator('.userfont-list')).toContainText('尚未安装外挂字体');
  });

  test('远程字体 URL：无效地址同步失败有提示；清空订阅有确认提示', async ({ page }) => {
    await openSettings(page);
    const area = page.getByLabel('远程字体 URL 列表');
    await area.fill('http://127.0.0.1:9/no-such-font.ttf'); // 保留端口：必然连接失败
    await page.getByRole('button', { name: '保存远程字体 URL 并立即同步' }).click();
    await expect(page.locator('.modal-box')).toContainText('失败 1 个', { timeout: 20_000 });
    // 清空订阅
    await area.fill('');
    await page.getByRole('button', { name: '保存远程字体 URL 并立即同步' }).click();
    await expect(page.locator('.modal-box')).toContainText('已清空远程字体订阅');
  });
});

test.describe('设置：关于（版本号与更新日志）', () => {
  test('版本号完整（vX.Y.Z · commit · 日期）；更新日志展开后含提交时间与主题', async ({ page }) => {
    await openSettings(page);
    // 版本行：v版本 · 短 commit · 构建日期
    await expect(page.locator('.about-row .ver-mono').first()).toHaveText(/v\d+\.\d+\.\d+ · [0-9a-f]{7,} · \d{4}-\d{2}-\d{2}/);
    // 更新日志（构建期从 git log 生成）
    await page.getByRole('button', { name: '查看更新日志' }).click();
    const list = page.getByRole('log', { name: '更新日志内容' });
    await expect(list).toBeVisible();
    await expect(page.locator('.changelog-box .cl-head')).toContainText(/共 \d+ 次提交/);
    const firstRow = list.locator('.cl-row').first();
    await expect(firstRow.locator('.cl-date')).toHaveText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    await expect(firstRow.locator('.cl-hash')).toHaveText(/[0-9a-f]{7,}/);
    await expect(firstRow.locator('.cl-subject')).toHaveText(/\S/);
    // 再点收起
    await page.getByRole('button', { name: '查看更新日志' }).click();
    await expect(list).toBeHidden();
  });
});
