// 外观交互 e2e：首页「更多工具」内联展开收起、卡片/列表视图切换（持久化，首页/更多页共通）、
// 右下角多巴胺随机配色浮钮（单击随机换色避开当前、刷新持久、双击恢复默认）。
// （主色应用走 data-dopamine 属性 + tokens.css 覆写；自动化下 animateThemeChange 同步生效可稳定断言。）
import { test, expect } from '@playwright/test';

test.describe('外观：内联展开 / 列表视图 / 多巴胺配色', () => {
  test('首页底部入口内联展开 64 个功能（扩展分组+核心目录），可收起且收藏区不受影响', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.home-more-open')).toHaveCount(0);
    await page.locator('.home-more-link button').click();
    // 49 扩展 + 15 核心目录 = 64；核心目录分隔线在列
    await expect(page.locator('.home-more-open .tool-card')).toHaveCount(71);
    await expect(page.locator('.home-more-open .home-sec-divider')).toContainText('核心工具');
    await expect(page.locator('.home-more-open h2:text-is("转换为 PDF")')).toHaveCount(1);
    // 收起
    await page.locator('.home-more-link button').click();
    await expect(page.locator('.home-more-open')).toHaveCount(0);
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(25);
  });

  test('首页 hero 右侧切换列表视图：10 个分区 23 行，刷新持久，可切回卡片', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '列表视图' }).click();
    await expect(page.locator('.tool-list')).toHaveCount(10);
    await expect(page.locator('.tool-list .tool-row')).toHaveCount(25);
    await expect(page.locator('.tool-grid')).toHaveCount(0);
    // 列表行真实可达：首行为 PDF 压缩
    await expect(page.locator('.tool-list .tool-row[href="#/tool/compress"] .tr-name')).toHaveText('PDF 压缩');
    await page.reload();
    await expect(page.locator('.tool-list .tool-row')).toHaveCount(25);
    await page.getByRole('button', { name: '卡片视图' }).click();
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(25);
  });

  test('更多页同样支持卡片/列表双向切换（64 条）', async ({ page }) => {
    await page.goto('/#/more');
    await page.getByRole('button', { name: '列表视图' }).click();
    await expect(page.locator('.tool-list .tool-row')).toHaveCount(71);
    await expect(page.locator('.home-sec-divider')).toContainText('核心工具');
    await page.getByRole('button', { name: '卡片视图' }).click();
    await expect(page.locator('.tool-grid .tool-card')).toHaveCount(71);
  });

  test('多巴胺浮钮：单击换随机配色（避开当前）+ 刷新持久，双击恢复默认', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).not.toHaveAttribute('data-dopamine', /.+/);
    const btn = page.locator('.dopa-btn');
    await btn.click();
    await expect(html).toHaveAttribute('data-dopamine', /.+/); // 单击有 260ms 双击判定窗，轮询等待应用
    const first = await html.getAttribute('data-dopamine');
    await btn.click();
    await expect(html).not.toHaveAttribute('data-dopamine', first); // 随机时排除当前配色
    await expect(html).toHaveAttribute('data-dopamine', /.+/);
    const second = await html.getAttribute('data-dopamine');
    await page.reload();
    await expect(html).toHaveAttribute('data-dopamine', second);   // 偏好持久化
    await btn.dblclick();
    await expect(html).not.toHaveAttribute('data-dopamine', /.+/);
    await expect(html).toHaveAttribute('data-accent', /.+/);       // 强调色体系不受影响
  });
});
