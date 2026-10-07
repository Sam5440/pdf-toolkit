// 首页「最近使用」+ 产物默认命名规则 e2e：
// 最近使用：打开工具 → 首页第一行记录（最新在前，≤10 条）→ 单条删除 → 设置开关/清空
// 命名规则：产物名 = 原名-操作-参数(≤10字符)-时间；模板可在设置自定义
import { test, expect } from '@playwright/test';
import { ensureFixtures, openTool, upload } from './helpers.js';

async function openSettings(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.modal-box')).toBeVisible();
}

test.describe('首页最近使用', () => {
  test.beforeEach(() => ensureFixtures());

  test('打开工具后首页第一行出现最近使用（最新在前），单条 × 可删', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.recent-sec')).toHaveCount(0); // 初始无记录
    await openTool(page, 'compress');
    await openTool(page, 'merge');
    await page.goto('/');
    const row = page.locator('.recent-sec .recent-row');
    await expect(row).toBeVisible();
    // 顺序 = 最近使用在前；位于首页第一行（先于 hero 卡）
    await expect(row.locator('.recent-chip').nth(0).locator('.rc-name')).toHaveText('合并 PDF');
    await expect(row.locator('.recent-chip').nth(1).locator('.rc-name')).toHaveText('PDF 压缩');
    const first = page.locator('.content > *').first();
    await expect(first.locator('.recent-row')).toBeVisible();
    // 单条删除：记录消失但其余保留
    await row.locator('.recent-chip').nth(0).getByRole('button', { name: '删除最近记录：合并 PDF' }).click();
    await expect(page.locator('.recent-sec .recent-chip')).toHaveCount(1);
    await expect(page.locator('.recent-sec .rc-name')).toHaveText('PDF 压缩');
  });

  test('设置开关：关闭后首页隐藏且不再记录；重新开启恢复（记录保留）；清空按钮清空全部', async ({ page }) => {
    await openTool(page, 'compress');
    await page.goto('/');
    await expect(page.locator('.recent-sec .recent-chip')).toHaveCount(1);
    // 关闭开关
    await openSettings(page);
    await page.getByRole('checkbox', { name: /记录最近使用的功能/ }).uncheck();
    await page.keyboard.press('Escape');
    await page.goto('/');
    await expect(page.locator('.recent-sec')).toHaveCount(0);
    // 关闭后打开新工具不记录
    await openTool(page, 'merge');
    await page.goto('/');
    await expect(page.locator('.recent-sec')).toHaveCount(0);
    // 重新开启：旧记录恢复显示
    await openSettings(page);
    await page.getByRole('checkbox', { name: /记录最近使用的功能/ }).check();
    await page.keyboard.press('Escape');
    await page.goto('/');
    await expect(page.locator('.recent-sec .recent-chip')).toHaveCount(1);
    await expect(page.locator('.recent-sec .rc-name')).toHaveText('PDF 压缩');
    // 清空按钮
    await openSettings(page);
    await page.getByRole('button', { name: '清空最近使用记录' }).click();
    await page.keyboard.press('Escape');
    await page.goto('/');
    await expect(page.locator('.recent-sec')).toHaveCount(0);
  });
});

test.describe('产物默认命名规则', () => {
  test.beforeEach(() => ensureFixtures());

  /** 提取文本并取下载文件名（结果卡不直接展示产物名，以下载名为准） */
  async function extractTxtName(page) {
    await openTool(page, 'text');
    await upload(page, ['multi3.pdf'], false);
    await page.getByRole('button', { name: '开始提取' }).click();
    const dlP = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载 TXT' }).click();
    const dl = await dlP;
    return dl.suggestedFilename();
  }

  test('提取文本产物：原名-操作-参数(截断10字符)-时间.txt', async ({ page }) => {
    const name = await extractTxtName(page);
    expect(name).toMatch(/^multi3-提取文字-.+-\d{8}-\d{4}\.txt$/);
  });

  test('设置自定义模板生效：{name}_{op}_{time} → 下划线连接且无参数段', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await page.getByLabel('产物命名模板').fill('{name}_{op}_{time}');
    await page.keyboard.press('Escape');
    const name = await extractTxtName(page);
    expect(name).toMatch(/^multi3_提取文字_\d{8}-\d{4}\.txt$/);
  });
});
