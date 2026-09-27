// 拍摄应用主界面截图（README 用）：明/暗主题首页 + 工具页
// 用法: node scripts/app-screenshots.mjs  （要求 8088 已启动且为最新构建）
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.SHOT_BASE || 'http://localhost:8088';
const OUT = 'docs/screenshots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

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
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/home-dark.png` });

// 恢复浅色，避免污染后续本地会话
await page.evaluate(() => localStorage.removeItem('pdftoolkit.settings.v1'));
await browser.close();
console.log('shots:', fs.readdirSync(OUT).join(', '));
