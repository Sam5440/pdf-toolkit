// 收藏系统 e2e：首页=收藏集合（按分类分区）、#/more 专项页、星标白/黄切换与持久化
import { test, expect } from '@playwright/test';

test.describe('收藏系统', () => {
  test('首页默认显示 25 个工具（15 核心 + 10 个常用扩展工具），按分类分区', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.home-sec h2')).toHaveCount(10, { timeout: 15_000 });
    await expect(page.locator('.home-sec h2')).toHaveText(['优化', '页面', '内容', '转换', '安全', '检查', '页面处理', '转换为 PDF', 'PDF 转格式', '实用工具']);
    const cards = page.locator('.tool-grid .tool-card');
    await expect(cards).toHaveCount(25);
    // crop / md2pdf / pdf2pptimg 及实用工具 7 件（defaultFav）默认在首页各自分区
    await expect(page.locator('.home-sec:has(h2:text-is("页面处理")) + .tool-grid a.tool-card[href="#/tool/crop"]')).toHaveCount(1);
    await expect(page.locator('.home-sec:has(h2:text-is("转换为 PDF")) + .tool-grid a.tool-card[href="#/tool/md2pdf"]')).toHaveCount(1);
    await expect(page.locator('.home-sec:has(h2:text-is("PDF 转格式")) + .tool-grid a.tool-card[href="#/tool/pdf2pptimg"]')).toHaveCount(1);
    for (const id of ['qrcode-scan', 'hash-calc', 'crypt', 'imgocr', 'filebed']) {
      await expect(page.locator(`.home-sec:has(h2:text-is("实用工具")) + .tool-grid a.tool-card[href="#/tool/${id}"]`)).toHaveCount(1);
    }
    // 其余更多工具不出现在首页
    await expect(page.locator('a.tool-card[href="#/tool/rotate"]')).toHaveCount(0);
    await expect(page.locator('a.tool-card[href="#/tool/qrcode"]')).toHaveCount(0);
    // 星标默认态：已收藏（黄）
    await expect(page.locator('[data-star="compress"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-star="crop"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-star="md2pdf"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-star="pdf2pptimg"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.fav-star.on')).toHaveCount(25);
    // 底部入口：内联展开切换（点击在下方展开全部扩展功能，不再跳转专项页）
    await expect(page.locator('.home-more-link button')).toContainText('更多工具页');
  });

  test('#/more 专项页：扩展分类在前、核心目录在后，71 张卡', async ({ page }) => {
    await page.goto('/#/more');
    await expect(page.locator('.tb-title')).toContainText('更多工具');
    const heads = page.locator('.home-sec h2');
    await expect(heads.filter({ hasText: '页面处理' })).toHaveCount(1);
    await expect(heads.filter({ hasText: '转换为 PDF' })).toHaveCount(1);
    await expect(page.locator('.home-sec h2:text-is("优化")')).toHaveCount(1);
    await expect(page.locator('.home-sec-divider')).toHaveCount(1);
    // 56 扩展 + 15 核心 = 71 张卡
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(71);
    await expect(page.locator('[data-star="crop"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-star="md2pdf"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-star="pdf2pptimg"]')).toHaveAttribute('aria-pressed', 'true');
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
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(24);
    // 刷新持久化
    await page.reload();
    await expect(page.locator('a.tool-card[href="#/tool/compress"]')).toHaveCount(0);
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(24);
    // 恢复：去专项页重新收藏（首页已无该卡片可点）
    await page.goto('/#/more');
    await page.locator('[data-star="compress"]').click();
    await expect(page.locator('[data-star="compress"]')).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/');
    await expect(page.locator('a.tool-card[href="#/tool/compress"]')).toHaveCount(1);
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(25);
  });

  test('全部取消收藏 → 空状态引导；恢复默认收藏按钮', async ({ page }) => {
    await page.goto('/');
    // 依次取消全部默认收藏工具
    const stars = page.locator('.tool-grid .fav-star');
    const n = await stars.count();
    for (let i = 0; i < n; i++) {
      await page.locator('.tool-grid .fav-star').first().click();
    }
    await expect(page.locator('.empty')).toContainText('还没有收藏的工具');
    // 设置 → 恢复默认收藏
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByRole('button', { name: '恢复默认收藏' }).click();
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(25);
  });
});
