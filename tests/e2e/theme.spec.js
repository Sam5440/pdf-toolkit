// 主题切换 e2e：顶栏按钮 / 设置弹窗下拉 / 强调色，切换即时生效并持久化。
// （切换动画本体在 CSS/View Transitions 层；自动化下 animateThemeChange 走
// 同步回退路径，class 状态在 click 返回时已确定，可稳定断言。）
import { test, expect } from '@playwright/test';

test.describe('主题切换', () => {
  test('顶栏按钮切换深浅色，按钮文案与 html.dark 同步，刷新持久', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).not.toHaveClass(/dark/);
    await page.getByRole('button', { name: '深色' }).click();
    await expect(html).toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: '浅色' })).toBeVisible();
    // 刷新后保持深色（localStorage 持久化）
    await page.reload();
    await expect(html).toHaveClass(/dark/);
    // 切回浅色
    await page.getByRole('button', { name: '浅色' }).click();
    await expect(html).not.toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: '深色' })).toBeVisible();
  });

  test('设置弹窗主题下拉切换并同步顶栏按钮，无需刷新', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).click();
    // 外观区第一个 select 即主题
    const themeSel = page.locator('.modal-box select').first();
    await themeSel.selectOption('dark');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: '浅色' })).toBeVisible();
    await themeSel.selectOption('light');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-box')).toHaveCount(0);
  });

  test('强调色切换不改深浅状态，选择标记更新', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '设置' }).click();
    const swatches = page.locator('.accent-swatch');
    await swatches.nth(1).click(); // 蓝色
    await expect(swatches.nth(1)).toHaveAttribute('data-selected', '');
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.keyboard.press('Escape');
  });
});
