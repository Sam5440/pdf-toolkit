// 拍摄应用主界面截图（README 用）：明/暗主题首页 + 工具页
// 用法: node scripts/app-screenshots.mjs  （要求本地已启动最新构建，默认 8137）
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8137';
const OUT = 'docs/screenshots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
// 开场动画最短展示 700ms + 淡出 500ms：等 splash 完全退场再拍
await page.waitForSelector('.tool-grid', { timeout: 20_000 });
await page.waitForFunction(() => !document.querySelector('.boot-splash'), null, { timeout: 10_000 });
await page.waitForTimeout(300);

// 明色首页
await page.screenshot({ path: `${OUT}/home-light.png` });

// 工具页（水印，界面元素最丰富）
await page.goto(BASE + '/#/tool/watermark', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/tool-watermark-light.png` });

// 暗色首页（通过 localStorage 设置主题后刷新）
await page.evaluate(() => localStorage.setItem('pdftoolkit.settings.v1', JSON.stringify({ theme: 'dark', maxUploadMB: 500, historyQuotaMB: 500, ocrDpi: 200 })));
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.tool-grid', { timeout: 20_000 });
await page.waitForFunction(() => !document.querySelector('.boot-splash'), null, { timeout: 10_000 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/home-dark.png` });

// 恢复浅色，避免污染后续本地会话
await page.evaluate(() => localStorage.removeItem('pdftoolkit.settings.v1'));
await browser.close();
console.log('shots:', fs.readdirSync(OUT).join(', '));
