// 「更多」分组 安全/内容/导出 类工具 e2e（pagenumbers/sign/redact/formfill/formcreate/
// flatten/rasterize/repair/viewer/search + 8 个导出 + pdf2tiff + pdf2svg）
// 链路要求：真实点击导航、真实 filechooser 上传、真实下载捕获（禁止 DOM 注入伪造）。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureFixtures, openTool, upload, saveDownload, ARTIFACTS, FIXTURES,
} from './helpers.js';

test.beforeAll(() => ensureFixtures());

/** 等待产物行出现并下载（单产物工具通用） */
async function downloadWhenReady(page, saveName) {
  await page.getByRole('button', { name: '下载', exact: true }).first().waitFor({ timeout: 90_000 });
  return saveDownload(page, '下载', saveName);
}

test.describe('more · pagenumbers / flatten / rasterize / repair', () => {
  test('添加页码：默认底部居中 → 产物下载（pytest 验证位图页码）', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'pagenumbers');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '开始编号' })).toBeEnabled();
    await page.getByRole('button', { name: '开始编号' }).click();
    const p = await downloadWhenReady(page, 'mc-pagenumbers.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('扁平化：整册栅格化（150 DPI）→ 文字烧入为图像', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'flatten');
    await upload(page, ['multi3.pdf'], false);
    await page.locator('input[name="flatten-mode"][value="raster"]').check();
    await expect(page.getByRole('button', { name: '开始扁平化' })).toBeEnabled();
    await page.getByRole('button', { name: '开始扁平化' }).click();
    const p = await downloadWhenReady(page, 'mc-flatten.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('栅格化：jpeg/150DPI → 产物下载', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'rasterize');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '开始栅格化' })).toBeEnabled();
    await page.getByRole('button', { name: '开始栅格化' }).click();
    const p = await downloadWhenReady(page, 'mc-raster.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('修复：程序化损坏 PDF（中部字节改写）→ 产物可下载（pytest 验证可开）', async ({ page }) => {
    test.setTimeout(120_000);
    // 生成损坏文件：把第一个内容流中部的压缩字节改写（结构可解析、数据已损坏）
    const src = fs.readFileSync(path.join(FIXTURES, 'multi3.pdf'));
    const corrupted = Buffer.from(src);
    const streamIdx = corrupted.indexOf(Buffer.from('stream'));
    expect(streamIdx).toBeGreaterThan(0);
    corrupted.write(Buffer.alloc(24, 0xff).toString('latin1'), streamIdx + 16, 'latin1');
    const tmpDir = path.join(ARTIFACTS, '..', '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const corruptPath = path.join(tmpDir, 'corrupt.pdf');
    fs.writeFileSync(corruptPath, corrupted);

    await openTool(page, 'repair');
    await upload(page, [corruptPath], false);
    await expect(page.getByRole('button', { name: '开始修复' })).toBeEnabled();
    await page.getByRole('button', { name: '开始修复' }).click();
    const p = await downloadWhenReady(page, 'mc-repair.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
    await expect(page.getByText(/mupdf|pdf-lib/).first()).toBeVisible();
  });
});

test.describe('more · sign', () => {
  test('手绘签名：canvas 画几笔 → 落章到第 1 页 → 下载', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'sign');
    await upload(page, ['multi3.pdf'], false);
    const canvas = page.locator('[data-sign-canvas]');
    await expect(canvas).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '落章到 PDF' })).toBeEnabled();

    // 在签名板画一个 zigzag + 横线（真实鼠标事件 → pointer 画线）
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5);
    await page.mouse.down();
    for (let i = 0; i <= 24; i++) {
      await page.mouse.move(
        box.x + box.width * (0.1 + 0.8 * i / 24),
        box.y + box.height * (0.5 + 0.32 * Math.sin(i / 2.5)),
        { steps: 2 },
      );
    }
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.8, { steps: 4 });
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.8, { steps: 8 });
    await page.mouse.up();

    await page.getByRole('button', { name: '落章到 PDF' }).click();
    const p = await downloadWhenReady(page, 'mc-sign.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });
});

test.describe('more · redact', () => {
  test('数值兜底添加区域 → 执行涂黑 → 下载（pytest 验证文字删除）', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'redact');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.locator('[data-rd-canvas]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-rd-page]')).toContainText('第 1 / 3 页');

    await page.locator('[data-rd-npage]').fill('1');
    await page.locator('[data-rd-nx]').fill('40');
    await page.locator('[data-rd-ny]').fill('50');
    await page.locator('[data-rd-nw]').fill('300');
    await page.locator('[data-rd-nh]').fill('50');
    await page.locator('[data-rd-add]').click();
    await expect(page.locator('[data-rd-marks]')).toContainText('第 1 页');

    await page.getByRole('button', { name: '执行涂黑' }).click();
    const p = await downloadWhenReady(page, 'mc-redact.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
    // 涂黑方式提示（mupdf 深度涂黑或回退黑框；引擎修复前为黑框遮盖）
    await expect(page.getByText(/深度涂黑|黑框遮盖/).first()).toBeVisible();
  });
});

test.describe('more · formcreate / formfill', () => {
  test('创建表单：文本框字段 → 下载（pytest 验证字段存在）', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'formcreate');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '创建表单字段' })).toBeEnabled({ timeout: 15000 });

    // 第 1 行（默认已有一行）：文本框 fullname
    // 注：复选框类型依赖引擎 form.create（createCheckbox 方法名缺陷）修复后补充用例
    const row1 = page.locator('[data-fc-row]').nth(0);
    await row1.locator('[data-fc-name]').fill('fullname');
    await row1.locator('[data-fc-x]').fill('60');
    await row1.locator('[data-fc-y]').fill('120');
    await row1.locator('[data-fc-w]').fill('180');
    await row1.locator('[data-fc-h]').fill('24');

    await page.getByRole('button', { name: '创建表单字段' }).click();
    const p = await downloadWhenReady(page, 'mc-form.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('填写表单：上传 formcreate 产物 → 填写并扁平化 → 下载', async ({ page }) => {
    test.setTimeout(120_000);
    const formPdf = path.join(ARTIFACTS, 'mc-form.pdf');
    test.skip(!fs.existsSync(formPdf), '前置 formcreate 用例未产出 mc-form.pdf');
    await openTool(page, 'formfill');
    await upload(page, [formPdf], false);
    await expect(page.locator('[data-ff-fields]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-ff-name="fullname"]')).toBeVisible();

    await page.locator('input[data-ff-name="fullname"]').fill('Sam Lee');
    await page.locator('[data-ff-flatten]').check(); // 扁平化：字段转为静态内容
    await page.getByRole('button', { name: '开始填写' }).click();
    const p = await downloadWhenReady(page, 'mc-ff-flat.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('填写表单（不扁平化）：值可读回（pytest 验证字段值）', async ({ page }) => {
    test.setTimeout(120_000);
    const formPdf = path.join(ARTIFACTS, 'mc-form.pdf');
    test.skip(!fs.existsSync(formPdf), '前置 formcreate 用例未产出 mc-form.pdf');
    await openTool(page, 'formfill');
    await upload(page, [formPdf], false);
    await expect(page.locator('[data-ff-fields]')).toBeVisible({ timeout: 15000 });
    await page.locator('input[data-ff-name="fullname"]').fill('Sam Lee');
    await page.getByRole('button', { name: '开始填写' }).click();
    const p = await downloadWhenReady(page, 'mc-ff-noflat.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('边界：无表单文件 → 友好空态', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'formfill');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.locator('[data-ff-empty]')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: '开始填写' })).toBeDisabled();
  });
});

test.describe('more · viewer / search', () => {
  test('查看器：打开 multi3 → 翻页页码变化（无下载）', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'viewer');
    await upload(page, ['multi3.pdf'], false);
    const label = page.locator('[data-vw-label]');
    await expect(label).toContainText('第 1 / 3 页', { timeout: 15000 });
    await page.locator('[data-vw-next]').click();
    await expect(label).toContainText('第 2 / 3 页');
    await page.locator('[data-vw-prev]').click();
    await expect(label).toContainText('第 1 / 3 页');
    // 缩放切换不报错且仍显示第 1 页
    await page.locator('[data-vw-zoom]').selectOption('1.5');
    await expect(label).toContainText('第 1 / 3 页');
  });

  test('搜索：multi3 搜 "Fixture" → 命中统计 + 摘要', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'search');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '开始搜索' })).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-se-query]').fill('Fixture');
    await page.getByRole('button', { name: '开始搜索' }).click();
    const total = page.locator('[data-search-total]');
    await expect(total).toBeVisible({ timeout: 60_000 });
    const txt = await total.textContent();
    expect(txt).toMatch(/共 [1-9]\d* 处命中/);
    await expect(page.locator('[data-search-results]')).toContainText('第 1 页');
  });

  test('边界：搜索不存在的词 → 空结果友好提示', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'search');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '开始搜索' })).toBeEnabled({ timeout: 15000 });
    await page.locator('[data-se-query]').fill('ZZZ不存在的词QQQ');
    await page.getByRole('button', { name: '开始搜索' }).click();
    await expect(page.locator('[data-search-empty]')).toBeVisible({ timeout: 60_000 });
  });
});

test.describe('more · 导出族（文本级转换）', () => {
  const cases = [
    ['pdf2word', 'mc-word.docx'],
    ['pdf2ppt', 'mc-ppt.pptx'],
    ['pdf2excel', 'mc-excel.xlsx'],
    ['pdf2html', 'mc-html.html'],
    ['pdf2md', 'mc-md.md'],
    ['pdf2rtf', 'mc-rtf.rtf'],
    ['pdf2epub', 'mc-epub.epub'],
  ];

  for (const [toolId, saveName] of cases) {
    test(`${toolId}：multi3 → 下载 ${saveName}`, async ({ page }) => {
      test.setTimeout(120_000);
      await openTool(page, toolId);
      await upload(page, ['multi3.pdf'], false);
      await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled();
      await page.getByRole('button', { name: '开始转换' }).click();
      const p = await downloadWhenReady(page, saveName);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    });
  }

  test('pdf2odf：默认 ODT → 下载', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'pdf2odf');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled();
    await page.getByRole('button', { name: '开始转换' }).click();
    const p = await downloadWhenReady(page, 'mc-odt.odt');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('pdf2tiff：150 DPI → 下载多页 TIFF', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'pdf2tiff');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled();
    await page.getByRole('button', { name: '开始转换' }).click();
    const p = await downloadWhenReady(page, 'mc-tiff.tiff');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });

  test('pdf2svg：每页一个 SVG → 打包 ZIP 下载', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'pdf2svg');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled();
    await page.getByRole('button', { name: '开始转换' }).click();
    await page.getByRole('button', { name: '打包下载 ZIP' }).waitFor({ timeout: 90_000 });
    const p = await saveDownload(page, '打包下载 ZIP', 'mc-svg.zip');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });
});

test.describe('more · PDF 转图片型 PPT（默认收藏）', () => {
  test('pdf2pptimg：multi3 默认参数 → 下载 mc-pptimg.pptx（每页一帧整页图）', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'pdf2pptimg');
    await upload(page, ['multi3.pdf'], false);
    await expect(page.getByRole('button', { name: '开始转换' })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole('button', { name: '开始转换' }).click();
    const p = await downloadWhenReady(page, 'mc-pptimg.pptx');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
  });
});
