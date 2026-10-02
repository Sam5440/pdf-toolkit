// 收藏系统 e2e：首页=收藏集合（按分类分区）、#/more 专项页、星标白/黄切换与持久化
import { test, expect } from '@playwright/test';

test.describe('收藏系统', () => {
  test('首页默认显示 16 个工具（15 核心 + Markdown 转 PDF），按分类分区', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.home-sec h2')).toHaveCount(7, { timeout: 15_000 });
    await expect(page.locator('.home-sec h2')).toHaveText(['优化', '页面', '内容', '转换', '安全', '检查', '转换为 PDF']);
    const cards = page.locator('.tool-grid .tool-card');
    await expect(cards).toHaveCount(16);
    // md2pdf（defaultFav）默认在首页「转换为 PDF」分区
    await expect(page.locator('.home-sec:has(h2:text-is("转换为 PDF")) + .tool-grid a.tool-card[href="#/tool/md2pdf"]')).toHaveCount(1);
    // 其余更多工具不出现在首页
    await expect(page.locator('a.tool-card[href="#/tool/rotate"]')).toHaveCount(0);
    await expect(page.locator('a.tool-card[href="#/tool/qrcode"]')).toHaveCount(0);
    // 星标默认态：已收藏（黄）
    await expect(page.locator('[data-star="compress"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-star="md2pdf"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.fav-star.on')).toHaveCount(16);
    // 底部入口链接到专项页
    await expect(page.locator('a[href="#/more"].btn')).toContainText('更多工具页');
  });

  test('#/more 专项页：扩展分类在前、核心目录在后，63 张卡', async ({ page }) => {
    await page.goto('/#/more');
    await expect(page.locator('.tb-title')).toContainText('更多工具');
    const heads = page.locator('.home-sec h2');
    await expect(heads.filter({ hasText: '页面处理' })).toHaveCount(1);
    await expect(heads.filter({ hasText: '转换为 PDF' })).toHaveCount(1);
    await expect(page.locator('.home-sec h2:text-is("优化")')).toHaveCount(1);
    await expect(page.locator('.home-sec-divider')).toHaveCount(1);
    // 48 扩展 + 15 核心 = 63 张卡
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(63);
    await expect(page.locator('[data-star="md2pdf"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-star="qrcode"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-star="compress"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('星标切换：更多页收藏 → 立即出现在首页对应分类下；取消后消失', async ({ page }) => {
    await page.goto('/#/more');
    const star = page.locator('[data-star="qrcode"]');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    // 专项页原位更新（卡片保留）
    await expect(page.locator('a.tool-card[href="#/tool/qrcode"]')).toHaveCount(1);
    await page.goto('/');
    await expect(page.locator('a.tool-card[href="#/tool/qrcode"]')).toHaveCount(1);
    // 归入其功能分类分区「实用工具」
    const card = page.locator('.home-sec:has(h2:text-is("实用工具")) + .tool-grid a.tool-card[href="#/tool/qrcode"]');
    await expect(card).toHaveCount(1);
    // 取消收藏 → 首页消失
    await page.goto('/#/more');
    await page.locator('[data-star="qrcode"]').click();
    await expect(page.locator('[data-star="qrcode"]')).toHaveAttribute('aria-pressed', 'false');
    await page.goto('/');
    await expect(page.locator('a.tool-card[href="#/tool/qrcode"]')).toHaveCount(0);
  });

  test('首页取消收藏核心工具 → 卡片消失；刷新后持久化', async ({ page }) => {
    await page.goto('/');
    const star = page.locator('[data-star="compress"]');
    await expect(page.locator('a.tool-card[href="#/tool/compress"]')).toBeVisible();
    await star.click();
    // 首页即时重渲染：卡片消失
    await expect(page.locator('a.tool-card[href="#/tool/compress"]')).toHaveCount(0);
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(15);
    // 刷新持久化
    await page.reload();
    await expect(page.locator('a.tool-card[href="#/tool/compress"]')).toHaveCount(0);
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(15);
    // 恢复：去专项页重新收藏（首页已无该卡片可点）
    await page.goto('/#/more');
    await page.locator('[data-star="compress"]').click();
    await expect(page.locator('[data-star="compress"]')).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/');
    await expect(page.locator('a.tool-card[href="#/tool/compress"]')).toHaveCount(1);
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(16);
  });

  test('全部取消收藏 → 空状态引导；恢复默认收藏按钮', async ({ page }) => {
    await page.goto('/');
    // 依次取消 16 个默认收藏工具
    const stars = page.locator('.tool-grid .fav-star');
    const n = await stars.count();
    for (let i = 0; i < n; i++) {
      await page.locator('.tool-grid .fav-star').first().click();
    }
    await expect(page.locator('.empty')).toContainText('还没有收藏的工具');
    // 设置 → 恢复默认收藏
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: '恢复默认收藏' }).click();
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(16);
  });
});
