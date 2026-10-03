// 截图图标画廊：明/暗两屏，供目检验收
// 用法: node scripts/icon-gallery-shot.mjs [画廊.html] [输出前缀] [纵向切片数] [逗号分隔卡片id]
//   缺省 = docs/report-assets/icon-gallery.html icons 1（整屏，输出 icons-{light,dark}.png）
//   例: node scripts/icon-gallery-shot.mjs docs/report-assets/icon-gallery-color.html icons-color 2
//       node scripts/icon-gallery-shot.mjs docs/report-assets/icon-gallery.html fix "" pagenumbers,pdf2rtf,rtf2pdf
import { chromium } from 'playwright';
import path from 'node:path';

const [html = 'docs/report-assets/icon-gallery.html', prefix = 'docs/report-assets/icons', slicesArg = '1', cardsArg = ''] = process.argv.slice(2);
const SLICES = Math.max(1, parseInt(slicesArg, 10) || 1);
const CARDS = cardsArg ? cardsArg.split(',').filter(Boolean) : null;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.resolve(html));
await page.waitForTimeout(300);

async function shotSection(sel, base) {
  if (CARDS) {
    for (const id of CARDS) {
      await page.locator(`${sel} .card[data-id="${id}"]`).screenshot({ path: `${base}-${id}.png` });
    }
    return;
  }
  const el = page.locator(sel);
  if (SLICES === 1) {
    await el.screenshot({ path: `${base}.png` });
    return;
  }
  const box = await el.boundingBox();
  const sliceH = Math.ceil(box.height / SLICES);
  for (let i = 0; i < SLICES; i++) {
    await el.screenshot({
      path: `${base}-${i + 1}of${SLICES}.png`,
      clip: { x: 0, y: i * sliceH, width: box.width, height: Math.min(sliceH, box.height - i * sliceH) },
    });
  }
}

await shotSection('.theme.light', `${prefix}-light`);
await page.locator('.theme.dark').scrollIntoViewIfNeeded();
await page.waitForTimeout(150);
await shotSection('.theme.dark', `${prefix}-dark`);
await browser.close();
console.log(`shots: ${prefix}-{light,dark}${SLICES > 1 ? '-*of' + SLICES : ''}${CARDS ? ' (cards: ' + CARDS.join(',') + ')' : ''}`);
