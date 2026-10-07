// 设置面板维护能力 e2e：运行日志分区（实时内容/级别过滤/复制/清空）、
// 引擎缓存信息展示、一键恢复初始环境（确认交互 + 清除后自动刷新 + 数据归零）
import { test, expect } from '@playwright/test';
import { ensureFixtures, openTool, upload } from './helpers.js';

async function openSettings(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.modal-box')).toBeVisible();
}

test.describe('设置：运行日志与维护', () => {
  test.beforeEach(() => ensureFixtures());

  test('运行日志分区：有真实内容（引擎/暂存区记录），级别过滤生效', async ({ page }) => {
    await openSettings(page);
    const logList = page.getByRole('log', { name: '运行日志内容' });
    await expect(logList).toBeVisible();
    // 启动阶段即有日志（暂存区水合/字体探测等）
    await expect(logList).not.toHaveText('暂无日志', { timeout: 10_000 });
    await expect(logList).toContainText('[INFO]');
    // 级别过滤：切到「仅错误」——启动期无错误 → 空态文案
    await page.getByLabel('日志级别过滤').selectOption('error');
    await expect(logList).toHaveText('暂无日志');
    await page.getByLabel('日志级别过滤').selectOption('info');
    await expect(logList).toContainText('[INFO]');
  });

  test('运行日志记录引擎 op 与产物入架（合并工具真实链路）', async ({ page }) => {
    await openTool(page, 'merge');
    await upload(page, ['multi3.pdf']);
    await page.getByRole('button', { name: '开始合并' }).click();
    await expect(page.getByText('合并完成')).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const logList = page.getByRole('log', { name: '运行日志内容' });
    await expect(logList).toContainText('pages.merge');
    await expect(logList).toContainText('入暂存区');
  });

  test('复制与清空日志按钮；引擎缓存信息展示', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSettings(page);
    // 复制全部（写剪贴板成功即不弹错误 toast）
    await page.getByRole('button', { name: '复制全部运行日志' }).click();
    await expect(page.getByText('日志已复制到剪贴板')).toBeVisible();
    // 清空 → 空态
    await page.getByRole('button', { name: '清空运行日志' }).click();
    await expect(page.getByRole('log', { name: '运行日志内容' })).toHaveText('暂无日志');
    // 引擎缓存信息行（0 个或 N 个引擎包均为合法状态，关键是行渲染且给出持久化语义）
    await expect(page.getByText(/已持久化 \d+ 个引擎包/)).toBeVisible();
  });

  test('一键恢复初始环境：确认后清除数据并自动刷新归零', async ({ page }) => {
    await openTool(page, 'viewer');
    await upload(page, ['multi3.pdf']);
    await expect(page.locator('.tray-rail [data-tray-item]')).toHaveCount(1);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '一键恢复初始环境（清除全部本机数据）' }).click();
    // 确认弹窗出现；先取消——数据保留
    await expect(page.getByText('将清除本机保存的全部应用数据')).toBeVisible();
    await page.locator('[data-cd-cancel]').click();
    await expect(page.locator('.tray-rail [data-tray-item]')).toHaveCount(1);
    // 再确认 → 清除 → 自动刷新（reload 保留 URL/hash，直接等水合后暂存区归零）
    await page.getByRole('button', { name: '一键恢复初始环境（清除全部本机数据）' }).click();
    await page.locator('[data-cd-confirm]').click();
    await expect(page.locator('.tray-rail [data-tray-item]')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('[data-tray-toggle] .tray-toggle-n')).toHaveCount(0); // 无徽标 = 空架
    // 本机设置已清除（主题等回到默认；日志会被新会话重新开始写入，不作断言）
    const settingsRaw = await page.evaluate(() => localStorage.getItem('pdftoolkit.settings.v1'));
    expect(settingsRaw).toBeNull();
  });

  test('确认弹窗文案明确列出将被清除的数据范围', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('button', { name: '一键恢复初始环境（清除全部本机数据）' }).click();
    const msg = page.getByText('将清除本机保存的全部应用数据');
    await expect(msg).toBeVisible();
    await expect(msg).toContainText('暂存区');
    await expect(msg).toContainText('历史记录');
    await expect(msg).toContainText('引擎缓存');
  });
});
