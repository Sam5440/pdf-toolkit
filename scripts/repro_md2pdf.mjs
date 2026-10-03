// 诊断脚本：把「问题 Markdown」文档真实走一遍网页 md2pdf 管线，下载产物 PDF 供渲染检查。
// 用法: node scripts/repro_md2pdf.mjs <md路径> [输出名]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const mdPath = process.argv[2];
const outName = process.argv[3] || 'repro-out.pdf';
if (!mdPath) { console.error('usage: node scripts/repro_md2pdf.mjs <md> [out.pdf]'); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto('http://127.0.0.1:8137/');
await page.locator('a.side-link[href="#/tool/md2pdf"]').waitFor();
await page.locator('a.side-link[href="#/tool/md2pdf"]').click();
await page.waitForTimeout(300);

// 关闭自动预览（省时间），直接转换
const auto = page.locator('[data-md-autopv]');
if (await auto.isChecked()) await auto.uncheck();

const chooserP = page.waitForEvent('filechooser');
await page.locator('.dropzone').first().click();
const chooser = await chooserP;
await chooser.setFiles([path.resolve(mdPath)]);
await page.waitForTimeout(600);

await page.getByRole('button', { name: '开始转换' }).click();
await page.getByText('处理完成').waitFor({ timeout: 120_000 });

const dlP = page.waitForEvent('download', { timeout: 60_000 });
await page.getByRole('button', { name: '下载' }).first().click();
const dl = await dlP;
const dest = path.resolve(outName);
await dl.saveAs(dest);
console.log('saved:', dest, fs.statSync(dest).size, 'bytes');
await browser.close();
