// 截图图标画廊：明/暗两屏，供目检验收
// 用法: node scripts/icon-gallery-shot.mjs
import { chromium } from 'playwright';
import path from 'node:path';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.resolve('docs/report-assets/icon-gallery.html'));
await page.waitForTimeout(300);
const light = page.locator('.theme.light');
await light.screenshot({ path: 'docs/report-assets/icons-light.png' });
// 滚到暗色区截图
await page.locator('.theme.dark').scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
await page.locator('.theme.dark').screenshot({ path: 'docs/report-assets/icons-dark.png' });
await browser.close();
console.log('shots: docs/report-assets/icons-{light,dark}.png');
