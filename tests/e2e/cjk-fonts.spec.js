// 内置中文字体回退 e2e：
//  - viewer 渲染「声明 SimSun 但未嵌入」的中文 PDF（worker pdf.js 路径，字体别名注册后应出墨迹）
//  - office 转换「显式指定微软雅黑/宋体/楷体/仿宋」的 PPTX（SVG 栅格化路径，@font-face 注入后应出墨迹）
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { ensureFixtures, openTool, upload, saveDownload } from './helpers.js';

test.describe('内置中文字体回退', () => {
  test.beforeEach(() => ensureFixtures());

  test('viewer：未嵌入 SimSun 的中文 PDF 渲染出文字墨迹', async ({ page }) => {
    test.setTimeout(90_000);
    await openTool(page, 'viewer');
    await upload(page, ['cjk-simsun.pdf'], false);
    await expect(page.locator('[data-vw-label]')).toHaveText(/第 1 \/ 1 页/, { timeout: 60_000 });
    const ink = await page.evaluate(() => {
      const c = document.querySelector('[data-vw-canvas]');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      return dark / (d.length / 4);
    });
    expect(ink).toBeGreaterThan(0.003);
  });

  test('office：指定中文字体的 PPTX 转换产物含中文墨迹', async ({ page }) => {
    test.setTimeout(180_000);
    await openTool(page, 'office');
    await upload(page, ['slides-cjk.pptx'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await page.getByRole('button', { name: '下载 PDF' }).waitFor({ timeout: 120_000 });
    const p = await saveDownload(page, '下载 PDF', 'pptx-cjk-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
    const out = execSync(
      `python3 -c "
import fitz
d = fitz.open('${p}')
pix = d[0].get_pixmap(dpi=48)
data = pix.samples
n = pix.width * pix.height
dark = sum(1 for i in range(0, len(data), pix.n) if data[i] < 128)
print(round(dark / n, 4))
"`,
    ).toString().trim();
    expect(Number(out)).toBeGreaterThan(0.004);
  });
});
