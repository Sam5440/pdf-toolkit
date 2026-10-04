// 「更多 / 创建 PDF」簇 e2e（subagent：more-create）
// 成功链路全部走真实上传（filechooser）+ 真实下载捕获；失败链路断言错误提示。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ensureFixtures, openTool, upload, saveDownload, ARTIFACTS } from './helpers.js';

test.describe('更多 · 创建 PDF / 转换 / 小工具', () => {
  test.beforeEach(() => ensureFixtures());

  // ---- 生成 PDF（textarea 撰写） ----
  test('createpdf：填写 Markdown → 下载 PDF', async ({ page }) => {
    await openTool(page, 'createpdf');
    const ta = page.locator('[data-cp-text]');
    await ta.fill('# 项目周报\n\n本周完成了 **17 个工具**的控制器实现。\n\n- 待办一：e2e 覆盖\n- 待办二：pytest 校验\n\n| 项目 | 状态 |\n| --- | --- |\n| 构建 | 通过 |\n\n> 全程本地处理。\n\n---\n\n```\nconsole.log("done");\n```');
    await expect(page.getByRole('button', { name: '生成 PDF' })).toBeEnabled();
    await page.getByRole('button', { name: '生成 PDF' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'createpdf-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  // ---- 文本类上传转 PDF ----
  test('txtpdf：上传 txt → 下载 PDF', async ({ page }) => {
    await openTool(page, 'txtpdf');
    await expect(page.getByRole('button', { name: '开始转换' })).toBeDisabled();
    await upload(page, ['sample.txt'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'txtpdf-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  test('txtpdf：csv 走表格块', async ({ page }) => {
    await openTool(page, 'txtpdf');
    await upload(page, ['sample.csv'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    await saveDownload(page, '下载', 'txtpdf-csv-out.pdf');
  });

  test('md2pdf：上传 md → 下载 PDF', async ({ page }) => {
    await openTool(page, 'md2pdf');
    await upload(page, ['sample.md'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'md2pdf-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  test('rtf2pdf：上传 rtf → 下载 PDF', async ({ page }) => {
    await openTool(page, 'rtf2pdf');
    await upload(page, ['sample.rtf'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    await saveDownload(page, '下载', 'rtf2pdf-out.pdf');
  });

  test('epub2pdf：上传 epub（两章节自动分页）→ 下载 PDF', async ({ page }) => {
    await openTool(page, 'epub2pdf');
    await upload(page, ['sample.epub'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'epub2pdf-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  test('odf2pdf：上传 odt → 下载 PDF', async ({ page }) => {
    await openTool(page, 'odf2pdf');
    await upload(page, ['sample.odt'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'odf2pdf-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  test('excelpdf：上传 xlsx → 下载 PDF', async ({ page }) => {
    await openTool(page, 'excelpdf');
    await upload(page, ['sample.xlsx'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'excelpdf-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  // ---- 图像类转 PDF ----
  test('svgpdf：上传 svg → 光栅化 → 下载 PDF', async ({ page }) => {
    await openTool(page, 'svgpdf');
    await upload(page, ['diagram.svg']);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'svgpdf-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  test('tiffpdf：上传两页 tiff → 下载 2 页 PDF', async ({ page }) => {
    await openTool(page, 'tiffpdf');
    await upload(page, ['multi2.tiff'], false);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'tiffpdf-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  test('heicpdf：假 heic → 明确不支持提示', async ({ page }) => {
    await openTool(page, 'heicpdf');
    await upload(page, ['fake.heic']);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.locator('.alert-error', { hasText: '不支持 HEIC 解码' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.result-artifact')).toHaveCount(0);
  });

  // ---- 网页转 PDF（上传 HTML → 一键出 HTML 文件 + PDF） ----
  test('webpage：上传 html → 下载 HTML 文件 + PDF', async ({ page }) => {
    await openTool(page, 'webpage');
    await upload(page, ['sample.html'], false);
    await page.getByRole('button', { name: '一键转换（HTML 文件 + PDF）' }).click();
    await expect(page.getByText('处理完成：2 个文件')).toBeVisible({ timeout: 60_000 });
    // 产物顺序 PDF 第一行（基线产物维持 webpage-out.pdf），第二行为 .html 源码快照
    const p = await saveDownload(page, '下载', 'webpage-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
    await expect(page.locator('.result-artifact').filter({ hasText: '.html' })).toHaveCount(1);
  });

  // ---- 网页转 PDF（粘贴源码片段的新链路） ----
  test('webpage：粘贴 HTML 源码片段 → HTML 文件 + PDF', async ({ page }) => {
    await openTool(page, 'webpage');
    const ta = page.locator('[data-web-ta]');
    await ta.fill('<h1>粘贴测试</h1><p>这段代码没有 doctype，转换时自动包壳。</p>');
    await page.getByRole('button', { name: '一键转换（HTML 文件 + PDF）' }).click();
    await expect(page.getByText('处理完成：2 个文件')).toBeVisible({ timeout: 60_000 });
    const htmlRow = page.locator('.result-artifact').filter({ hasText: '.html' });
    await expect(htmlRow).toHaveCount(1);
    const dlP = page.waitForEvent('download', { timeout: 60_000 });
    await htmlRow.getByRole('button', { name: '下载' }).click();
    const dl = await dlP;
    const dest = `${ARTIFACTS}/webpage-paste-out.html`;
    await dl.saveAs(dest);
    const saved = fs.readFileSync(dest, 'utf8');
    expect(saved).toContain('<h1>粘贴测试</h1>');
    expect(saved).toContain('<!doctype html>');
  });

  // ---- 扫描件转 PDF（摄像头 mock） ----
  test('scan：mock 摄像头 → 拍照两张 → 删除一张 → 合成 PDF', async ({ page }) => {
    await page.addInitScript(() => {
      const makeStream = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');
        let n = 0;
        const paint = () => {
          n += 1;
          ctx.fillStyle = n % 2 ? '#2f7d4f' : '#245c8c';
          ctx.fillRect(0, 0, 640, 480);
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 56px sans-serif';
          ctx.fillText(`SCAN ${n}`, 220, 250);
        };
        paint();
        setInterval(paint, 120);
        return canvas.captureStream(12);
      };
      if (!navigator.mediaDevices) {
        Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
      }
      navigator.mediaDevices.getUserMedia = async () => makeStream();
    });

    await openTool(page, 'scan');
    await page.getByRole('button', { name: '打开摄像头' }).click();
    await expect
      .poll(() => page.locator('[data-scan-video]').evaluate((v) => (v.readyState >= 2 && v.videoWidth > 0 ? v.videoWidth : 0)), { timeout: 20_000 })
      .toBe(640);

    await page.locator('[data-scan-capture]').click();
    await expect(page.locator('[data-scan-thumb]')).toHaveCount(1);
    await page.locator('[data-scan-capture]').click();
    await expect(page.locator('[data-scan-thumb]')).toHaveCount(2);

    // 删除第 1 张
    await page.locator('[data-scan-thumb]').first().getByRole('button', { name: '删除' }).click();
    await expect(page.locator('[data-scan-thumb]')).toHaveCount(1);

    await page.locator('[data-scan-done]').click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'scan-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  // ---- 二维码 ----
  test('qrcode：填内容 → 预览 canvas → 下载 PNG', async ({ page }) => {
    await openTool(page, 'qrcode');
    const content = 'https://example.com/pdftoolkit-fixture';
    await page.locator('[data-qr-text]').fill(content);
    await page.getByRole('button', { name: '生成二维码' }).click();
    await expect(page.locator('[data-qr-preview] canvas')).toBeVisible();
    await expect(page.getByText('处理完成')).toBeVisible();
    const p = await saveDownload(page, '下载', 'qrcode-out.png');
    expect(fs.statSync(p).size).toBeGreaterThan(200);
  });

  // ---- 密码生成器 ----
  test('passgen：生成 → 非空只读；长度可调', async ({ page }) => {
    await openTool(page, 'passgen');
    await page.getByRole('button', { name: '生成密码' }).click();
    const out = page.locator('[data-pass-out]');
    await expect(out).not.toHaveValue('');
    const v16 = await out.inputValue();
    expect(v16.length).toBe(16);
    expect(/^[A-Za-z0-9!@#$%^&*()\-_=+\[\]{};:,.<>?/]+$/.test(v16)).toBe(true);

    await page.locator('[data-pass-len]').fill('32');
    await page.getByRole('button', { name: '生成密码' }).click();
    await expect(out).not.toHaveValue(v16);
    expect((await out.inputValue()).length).toBe(32);
  });

  // ---- 发票生成 ----
  test('invoice：两行条目 + 税率 → 金额汇总 → 下载 PDF', async ({ page }) => {
    await openTool(page, 'invoice');
    await page.locator('[data-inv-seller]').fill('示例科技有限公司');
    await page.locator('[data-inv-buyer]').fill('样板客户有限公司');
    await page.locator('[data-inv-tax]').fill('6');

    const row0 = page.locator('[data-inv-row]').first();
    await row0.locator('[data-inv-name]').fill('机械键盘');
    await row0.locator('[data-inv-qty]').fill('2');
    await row0.locator('[data-inv-price]').fill('199.5');

    await page.locator('[data-inv-add]').click();
    const row1 = page.locator('[data-inv-row]').nth(1);
    await row1.locator('[data-inv-name]').fill('无线鼠标');
    await row1.locator('[data-inv-qty]').fill('3');
    await row1.locator('[data-inv-price]').fill('49.9');

    // 小计 2×199.5 + 3×49.9 = 548.7；税 6% = 32.92；总计 581.62
    await expect(page.locator('[data-inv-sum]')).toContainText('小计：¥548.70');
    await expect(page.locator('[data-inv-sum]')).toContainText('税（6%）：¥32.92');
    await expect(page.locator('[data-inv-sum]')).toContainText('应收总计：¥581.62');

    await page.getByRole('button', { name: '生成发票 PDF' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'invoice-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  // ---- WebP 格式转换 ----
  test('webpconvert：webp → jpg 下载；尺寸保持', async ({ page }) => {
    await openTool(page, 'webpconvert');
    await upload(page, ['photo.webp']);
    await page.getByLabel('目标格式').selectOption('jpeg');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'webpconvert-out.jpg');
    expect(fs.statSync(p).size).toBeGreaterThan(200);
  });

  test('webpconvert：webp → png 下载', async ({ page }) => {
    await openTool(page, 'webpconvert');
    await upload(page, ['photo.webp']);
    await page.getByLabel('目标格式').selectOption('png');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 60_000 });
    await saveDownload(page, '下载', 'webpconvert-out.png');
  });

  // ---- HEIC 格式转换失败链路 ----
  test('heicconvert：假 heic → 明确不支持提示', async ({ page }) => {
    await openTool(page, 'heicconvert');
    await upload(page, ['fake.heic']);
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.locator('.alert-error', { hasText: '不支持 HEIC 解码' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.result-artifact')).toHaveCount(0);
  });
});
