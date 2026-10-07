// 任务历史/工作流/数据库 e2e：自动存档提示、详情参数、一键复原（文件+参数回填）、
// 存为工作流与工作流页、数据库页统计与整库导出。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('任务历史与一键复原', () => {
  test.beforeEach(() => {
    ensureFixtures();
  });

  async function runMerge(page) {
    await openTool(page, 'merge');
    await upload(page, ['multi3.pdf'], false);
    await page.locator('.field input[type="text"]').first().fill('1');
    await page.getByRole('button', { name: '开始合并' }).click();
    await expect(page.getByText('合并完成')).toBeVisible({ timeout: 30000 });
  }

  test('合并 PDF 自动存档（无手动按钮）→ 历史页出现自动存档记录', async ({ page }) => {
    await runMerge(page);
    await expect(page.getByText('已自动存入历史')).toBeVisible();
    // 自动记录开启时不出现手动「存入历史」按钮
    await expect(page.getByRole('button', { name: '存入历史' })).toHaveCount(0);

    await page.locator('button[aria-label="历史"]').click();
    await expect(page.getByRole('button', { name: '一键复原任务：合并 PDF' }).first()).toBeVisible();
    await expect(page.locator('.badge', { hasText: '自动存档' }).first()).toBeVisible();
  });

  test('详情弹窗展示参数与表单快照', async ({ page }) => {
    await runMerge(page);
    await page.locator('button[aria-label="历史"]').click();
    await page.getByRole('button', { name: '详情/下载任务：合并 PDF' }).first().click();
    await expect(page.getByText('表单快照')).toBeVisible();
    await expect(page.locator('.modal-box pre')).toContainText('"ranges"');
    await page.keyboard.press('Escape');
  });

  test('一键复原：回到工具页并回填文件与参数', async ({ page }) => {
    await runMerge(page);
    await page.locator('button[aria-label="历史"]').click();
    await page.getByRole('button', { name: '一键复原任务：合并 PDF' }).first().click();
    // 复原后回到合并工具页：文件在面板、页范围参数已回填
    await expect(page.locator('.file-list .tag').first()).toContainText('multi3.pdf', { timeout: 10000 });
    await expect(page.locator('.field input[type="text"]').first()).toHaveValue('1');
  });

  test('存为工作流 → 工作流页可见、可编辑、可打开运行弹窗', async ({ page }) => {
    await runMerge(page);
    await page.locator('button[aria-label="历史"]').click();
    await page.getByRole('button', { name: '把任务存为工作流步骤：合并 PDF' }).first().click();
    await expect(page.getByText(/已创建工作流/)).toBeVisible();

    await page.locator('button[aria-label="工作流"]').click();
    await expect(page.locator('.badge', { hasText: '1 步' })).toBeVisible();
    await expect(page.locator('.card b', { hasText: '合并 PDF' }).first()).toBeVisible();

    await page.getByRole('button', { name: /编辑工作流：/ }).click();
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByText('工作流已更新')).toBeVisible();

    await page.getByRole('button', { name: /运行工作流：/ }).click();
    await expect(page.getByRole('button', { name: '选择工作流起始文件' })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始执行' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
  test('工作流真实执行：旋转 → 提取文本 两步流水线', async ({ page }) => {
    test.setTimeout(180_000);
    // 第 1 步素材：旋转 90°
    await openTool(page, 'rotate');
    await upload(page, ['multi3.pdf'], false);
    await page.locator('select[data-rot-angle]').selectOption('90');
    await page.getByRole('button', { name: '开始旋转' }).click();
    await expect(page.getByText('处理完成：1 个文件')).toBeVisible({ timeout: 30000 });
    // 第 2 步素材：提取文本（页范围 1）
    await openTool(page, 'text');
    await upload(page, ['multi3.pdf'], false);
    await page.locator('.field input[type="text"]').first().fill('1');
    await page.getByRole('button', { name: '开始提取' }).click();
    await expect(page.getByText('提取完成')).toBeVisible({ timeout: 30000 });

    // 保存第 1 步为工作流，再把第 2 步并入
    await page.locator('button[aria-label="历史"]').click();
    await page.getByRole('button', { name: '把任务存为工作流步骤：旋转 PDF' }).first().click();
    await page.locator('button[aria-label="工作流"]').click();
    await page.getByRole('button', { name: /编辑工作流：/ }).click();
    await page.locator('select[aria-label="选择历史任务作为步骤"]').selectOption({ index: 1 });
    await page.getByRole('button', { name: '把选中的历史任务添加为步骤' }).click();
    await page.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByText('工作流已更新')).toBeVisible();

    // 运行：起始文件 multi3.pdf → 两步依序执行
    const trayBefore = await page.locator('[data-tray-item]').count();
    await page.getByRole('button', { name: /运行工作流：/ }).click();
    const chooserP = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '选择工作流起始文件' }).click();
    await (await chooserP).setFiles(['tests/fixtures/out/multi3.pdf']);
    await page.getByRole('button', { name: '开始执行' }).click();
    await expect(page.getByText(/工作流完成/)).toBeVisible({ timeout: 120000 });
    // 两步都到「完成」态；产物徽章：旋转 1 个，提取文本的 TXT 为客户端产物计 0
    await expect(page.locator('[data-status]', { hasText: '完成 · 产物 1' })).toHaveCount(1);
    await expect(page.locator('[data-status]', { hasText: /^完成/ })).toHaveCount(2);
    expect(await page.locator('[data-tray-item]').count()).toBeGreaterThan(trayBefore);
  });
});

test.describe('本地数据库页', () => {
  test.beforeEach(() => {
    ensureFixtures();
  });

  test('统计概览 + 整库导出下载', async ({ page }) => {
    await page.goto('/#/data');
    await expect(page.getByText('本地数据库')).toBeVisible();
    await expect(page.getByText(/历史任务（含输入\/输出文件）/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/暂存区（含文件夹）/)).toBeVisible();

    const p = await saveDownload(page, '导出全部本机数据为备份包', 'backup.zip');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.statSync(p).size).toBeGreaterThan(100);
  });
});
