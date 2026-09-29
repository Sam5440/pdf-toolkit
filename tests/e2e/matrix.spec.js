// 全量选项矩阵 e2e：对每个工具的不同选项组合做真实 UI 操作 + 真实下载，
// 产物存 .artifacts/matrix-*，由 tests/verify/test_matrix.py 做独立深度校验。
// 纪律：真实 filechooser 上传、真实点击、真实下载捕获；缺产物不记通过。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ensureFixtures, openTool, upload, saveDownload, FIXTURES } from './helpers.js';

const M = (n) => `matrix-${n}`;

/** overlay 等双面板工具：按面板定位 dropzone（仍走真实 filechooser） */
async function uploadTo(page, panelKey, file) {
  const chooserP = page.waitForEvent('filechooser');
  await page.locator(`[data-overlay-panel="${panelKey}"] .dropzone`).click();
  const chooser = await chooserP;
  await chooser.setFiles([path.join(FIXTURES, file)]);
  await page.waitForTimeout(400);
}

test.describe('选项矩阵：merge 合并', () => {
  test.beforeEach(async ({ page }) => { ensureFixtures(); await openTool(page, 'merge'); });

  test('PDF 与图片混合合并（图+PDF+图 → 5 页，顺序保持）', async ({ page }) => {
    await upload(page, ['photo_l.jpg', 'multi3.pdf', 'photo_p.jpg']);
    await page.getByRole('button', { name: '开始合并' }).click();
    await expect(page.getByText('合并完成')).toBeVisible({ timeout: 30000 });
    const p = await saveDownload(page, '下载合并结果', M('merge-mixed.pdf'));
    expect(fs.statSync(p).size).toBeGreaterThan(1000);
  });

  test('页范围合并（第一个文件取 1-3 页 → 共 6 页）', async ({ page }) => {
    await upload(page, ['multi8.pdf', 'multi3.pdf']);
    await page.getByPlaceholder('如 1-3,5（多个文件用逗号分隔对应，或留空）').fill('1-3,');
    await page.getByRole('button', { name: '开始合并' }).click();
    await expect(page.getByText('合并完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载合并结果', M('merge-range.pdf'));
  });

  test('纯图片合并（两张图 → 2 页 PDF）', async ({ page }) => {
    await upload(page, ['photo_l.jpg', 'photo_p.jpg']);
    await page.getByRole('button', { name: '开始合并' }).click();
    await expect(page.getByText('合并完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载合并结果', M('merge-imgs.pdf'));
  });
});

test.describe('选项矩阵：split 拆分', () => {
  test.beforeEach(async ({ page }) => { ensureFixtures(); await openTool(page, 'split'); });

  test('每 2 页一份（multi8 → 4 份 ZIP）', async ({ page }) => {
    await upload(page, ['multi8.pdf'], false);
    await page.locator('input[data-mode="every"]').check();
    await page.locator('input[data-split="n"]').fill('2');
    await page.getByRole('button', { name: '开始拆分' }).click();
    await expect(page.getByText('拆分完成')).toBeVisible({ timeout: 30000 });
    const p = await saveDownload(page, '打包下载 ZIP', M('split-every2.zip'));
    expect(fs.statSync(p).size).toBeGreaterThan(1000);
  });

  test('范围组拆分（1-2 / 3-5 / 6-8 → 3 份）', async ({ page }) => {
    await upload(page, ['multi8.pdf'], false);
    await page.locator('input[data-mode="ranges"]').check();
    await page.locator('textarea[data-split="ranges"]').fill('1-2\n3-5\n6-8');
    await page.getByRole('button', { name: '开始拆分' }).click();
    await expect(page.getByText('拆分完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '打包下载 ZIP', M('split-ranges.zip'));
  });
});

test.describe('选项矩阵：organize 页面整理', () => {
  test('全选复制 + 插入空白页（3 页 → 7 页）', async ({ page }) => {
    ensureFixtures(); await openTool(page, 'organize');
    await upload(page, ['multi3.pdf'], false);
    const cards = page.locator('.page-card');
    await expect(cards).toHaveCount(3, { timeout: 15000 });
    const tb = page.locator('[data-organize-toolbar]');
    await tb.getByRole('button', { name: '全选' }).click();
    await tb.getByRole('button', { name: '⧉ 复制所选' }).click();
    await expect(cards).toHaveCount(6);
    await cards.last().click();
    await page.getByRole('button', { name: '＋ 插入空白页' }).click();
    await expect(cards).toHaveCount(7);
    await page.getByRole('button', { name: '开始整理' }).click();
    await expect(page.getByText('整理完成：输出 7 页')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载整理结果', M('organize-dup-blank.pdf'));
  });
});

test.describe('选项矩阵：edit 页面编辑', () => {
  test('中文文字 + 高亮 + 矩形 + 椭圆同页混排', async ({ page }) => {
    ensureFixtures(); await openTool(page, 'edit');
    await upload(page, ['multi3.pdf'], false);
    await page.locator('[data-edit="canvas"]').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '文字框' }).click();
    const ta = page.locator('textarea[data-edit="textArea"]');
    await ta.fill('矩阵测试·中文编辑');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await expect(page.locator('.edit-obj[data-type="text"]')).toHaveCount(1);
    await page.getByRole('button', { name: '高亮矩形' }).click();
    await expect(page.locator('.edit-obj[data-type="highlight"]')).toHaveCount(1);
    await page.getByRole('button', { name: '矩形', exact: true }).click();
    await expect(page.locator('.edit-obj[data-type="rect"]')).toHaveCount(1);
    await page.getByRole('button', { name: '椭圆' }).click();
    await expect(page.locator('.edit-obj[data-type="ellipse"]')).toHaveCount(1);
    await page.getByRole('button', { name: '开始编辑' }).click();
    await expect(page.getByText('编辑完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载编辑结果', M('edit-shapes.pdf'));
  });
});

test.describe('选项矩阵：watermark 水印', () => {
  const apply = async (page, name) => {
    await page.getByRole('button', { name: '应用水印' }).click();
    await expect(page.getByText('水印应用完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载水印 PDF', M(name));
  };

  test.beforeEach(async ({ page }) => {
    ensureFixtures(); await openTool(page, 'watermark'); await upload(page, ['multi3.pdf'], false);
    // 工具初始为空态：先添加一个文字层再配置参数
    if (await page.locator('.empty').count()) {
      await page.getByRole('button', { name: '＋ 添加文字层' }).click();
    }
    await page.locator('[data-wm="text"]').waitFor();
  });

  test('平铺 + 奇偶行交错 + 自定义间距', async ({ page }) => {
    await page.locator('[data-wm="text"]').fill('平铺交错');
    await page.locator('input[data-wm="placement"][value="tile"]').check();
    await page.locator('[data-wm="stagger"]').check();
    await page.locator('[data-wm="tileSpacingX"]').fill('120');
    await page.locator('[data-wm="tileSpacingY"]').fill('90');
    await apply(page, 'wm-tile-stagger.pdf');
  });

  test('全屏铺满：密度 6 + 旋转 30° + 背景层', async ({ page }) => {
    await page.locator('[data-wm="text"]').fill('全屏背景');
    await page.locator('input[data-wm="placement"][value="fullscreen"]').check();
    await page.locator('[data-wm="density"]').fill('6');
    await page.locator('[data-wm="rotation"]').fill('30');
    await page.locator('[data-wm="layerSide"]').selectOption('under');
    await apply(page, 'wm-fullscreen-under.pdf');
  });

  test('图片水印：透明 PNG + 背景层 + 对角线', async ({ page }) => {
    await page.getByRole('button', { name: '添加图片层' }).click();
    const chooserP = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '选择图片', exact: true }).click();
    (await chooserP).setFiles([path.join(FIXTURES, 'alpha.png')]);
    await expect(page.locator('[data-wm="imageName"]')).toContainText('alpha.png');
    await page.locator('input[data-wm="placement"][value="diagonal"]').check();
    await page.locator('[data-wm="layerSide"]').selectOption('under');
    await page.locator('[data-wm="imageScale"]').fill('0.3');
    await apply(page, 'wm-image-diagonal.pdf');
  });

  test('模板变量（页码）+ 单个居中 + 粗体', async ({ page }) => {
    await page.locator('[data-wm="text"]').fill('第 ${pageNo}/${pageCount} 页');
    await page.locator('[data-wm="bold"]').check();
    await page.locator('input[data-wm="placement"][value="single"]').check();
    await apply(page, 'wm-template-vars.pdf');
  });
});

test.describe('选项矩阵：overlay 叠加', () => {
  test.beforeEach(async ({ page }) => { ensureFixtures(); await openTool(page, 'overlay'); });

  test('缩放 0.5 + 不透明度 50% + 前景', async ({ page }) => {
    await uploadTo(page, 'base', 'multi3.pdf');
    await uploadTo(page, 'overlay', 'multi3.pdf');
    await expect(page.locator('[data-ov="hint"]')).toContainText('共 3 组', { timeout: 20000 });
    await page.getByLabel('覆盖稿缩放（0.1 - 3，1 = 原始尺寸）').fill('0.5');
    await page.locator('[data-ov="opacity"]').fill('50');
    await page.getByLabel('层级').selectOption('over');
    await page.getByRole('button', { name: '开始叠加' }).click();
    await expect(page.getByText('叠加完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载叠加 PDF', M('overlay-scale-opacity.pdf'));
  });

  test('自定义配对 + 背景层', async ({ page }) => {
    await uploadTo(page, 'base', 'multi3.pdf');
    await uploadTo(page, 'overlay', 'multi3.pdf');
    await expect(page.locator('[data-ov="hint"]')).toContainText('共 3 组', { timeout: 20000 });
    await page.locator('[data-ov="mode"]').selectOption('custom');
    await page.locator('[data-ov="customRows"]').fill('1:2\n2:3');
    await page.getByLabel('层级').selectOption('under');
    await page.getByRole('button', { name: '开始叠加' }).click();
    await expect(page.getByText('叠加完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载叠加 PDF', M('overlay-custom-under.pdf'));
  });
});

test.describe('选项矩阵：compress 压缩', () => {
  test.beforeEach(async ({ page }) => { ensureFixtures(); await openTool(page, 'compress'); await upload(page, ['multi8.pdf'], false); });

  test('三模式寻优 + SSIM 评估开启', async ({ page }) => {
    await page.getByRole('button', { name: '开始压缩' }).click();
    await expect(page.getByText('推荐方案')).toBeVisible({ timeout: 120000 });
    const p = await saveDownload(page, '下载推荐结果', M('compress-auto.pdf'));
    expect(fs.statSync(p).size).toBeGreaterThan(500);
  });

  test('目标体积约束（0.2MB）+ 关闭 SSIM 提速', async ({ page }) => {
    await page.locator('input[type=number]').first().fill('0.2'); // 目标体积（MB）
    await page.getByRole('checkbox', { name: /评估质量/ }).uncheck();
    await page.getByRole('button', { name: '开始压缩' }).click();
    await expect(page.getByText('推荐方案')).toBeVisible({ timeout: 120000 });
    await saveDownload(page, '下载推荐结果', M('compress-target.pdf'));
  });
});

test.describe('选项矩阵：security 密码', () => {
  test.beforeEach(async ({ page }) => { ensureFixtures(); await openTool(page, 'security'); });

  test('加密：打开密码 + 收窄权限（取消复制/修改）', async ({ page }) => {
    await upload(page, ['multi3.pdf'], false);
    const pws = page.locator('input[type=password]');
    await pws.nth(0).fill('mtx123');
    await pws.nth(1).fill('mtx123');
    await page.getByRole('checkbox', { name: '复制文本与图像' }).uncheck();
    await page.getByRole('checkbox', { name: '修改内容' }).uncheck();
    await page.getByRole('button', { name: '开始加密' }).click();
    await expect(page.locator('.kv').filter({ hasText: '完成：' })).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载', M('security-enc-perms.pdf'));
  });

  test('解密：enc_user123.pdf 凭 user123 移除密码', async ({ page }) => {
    await page.getByRole('button', { name: '移除密码 / 解密' }).click();
    await upload(page, ['enc_user123.pdf'], false, 1);
    await page.locator('input[type=password]').last().fill('user123');
    await page.getByRole('button', { name: '开始解密（移除密码）' }).click();
    await expect(page.locator('.kv').filter({ hasText: '完成：' })).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载', M('security-dec.pdf'));
  });
});

test.describe('选项矩阵：ocr / text', () => {
  test('OCR：简体+英文双语言 + DPI 150 + 按页识别', async ({ page }) => {
    test.setTimeout(300_000);
    ensureFixtures(); await openTool(page, 'ocr');
    await upload(page, ['scan2.pdf'], false);
    await page.getByRole('checkbox', { name: '繁体中文' }).uncheck();
    await page.getByLabel('渲染 DPI（越高越准、越慢）').selectOption('150');
    await page.getByRole('button', { name: '开始识别' }).click();
    await expect(page.getByText('识别完成')).toBeVisible({ timeout: 280000 });
    await saveDownload(page, '下载', M('ocr-zh-en.pdf'));
  });

  test('文本提取：页范围 2-4 + 按页分隔标记', async ({ page }) => {
    ensureFixtures(); await openTool(page, 'text');
    await upload(page, ['multi8.pdf'], false);
    await page.getByLabel('页范围').fill('2-4');
    await page.getByRole('checkbox', { name: '按页分隔（每页前插入 "--- 第 N 页 ---"）' }).check();
    await page.getByRole('button', { name: '开始提取' }).click();
    await expect(page.getByText('提取完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载 TXT', M('text-range.txt'));
  });
});

test.describe('选项矩阵：images2pdf（留白修复验证）', () => {
  test.beforeEach(async ({ page }) => { ensureFixtures(); await openTool(page, 'images2pdf'); });

  test('默认「图片即一页」：横版照片 → 页面尺寸=图片尺寸（零留白）', async ({ page }) => {
    await upload(page, ['photo_l.jpg'], false);
    await page.getByLabel('纸张', { exact: true }).selectOption('auto');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载 PDF', M('i2p-auto.pdf'));
  });

  test('A4 + contain + 24pt 边距：标准纸张留白布局', async ({ page }) => {
    await upload(page, ['photo_p.jpg'], false);
    await page.getByLabel('纸张', { exact: true }).selectOption('a4');
    await page.getByLabel('适应方式', { exact: true }).selectOption('contain');
    await page.getByLabel('页边距（pt，仅固定纸张生效）').fill('24');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载 PDF', M('i2p-a4-contain.pdf'));
  });

  test('A4 + cover 填充裁切：无留白（修复验证）', async ({ page }) => {
    await upload(page, ['photo_p.jpg'], false);
    await page.getByLabel('纸张', { exact: true }).selectOption('a4');
    await page.getByLabel('适应方式', { exact: true }).selectOption('cover');
    await page.getByLabel('页边距（pt，仅固定纸张生效）').fill('0');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载 PDF', M('i2p-a4-cover.pdf'));
  });

  test('背景色 #ff0000 + 透明 PNG', async ({ page }) => {
    await upload(page, ['alpha.png'], false);
    await page.getByLabel('纸张', { exact: true }).selectOption('a4');
    await page.getByLabel('适应方式', { exact: true }).selectOption('contain');
    await page.getByLabel('背景色（透明图片的底色）').fill('#ff0000');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载 PDF', M('i2p-bg-red.pdf'));
  });

  test('两张图 + 强制横向', async ({ page }) => {
    await upload(page, ['photo_l.jpg', 'photo_p.jpg']);
    await page.getByLabel('纸张', { exact: true }).selectOption('auto');
    await page.getByLabel('方向', { exact: true }).selectOption('landscape');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible({ timeout: 30000 });
    await saveDownload(page, '下载 PDF', M('i2p-two-landscape.pdf'));
  });
});

test.describe('选项矩阵：pdf2images / extractimages', () => {
  test('PDF→PNG 150DPI 全部页（ZIP）', async ({ page }) => {
    ensureFixtures(); await openTool(page, 'pdf2images');
    await upload(page, ['multi3.pdf'], false);
    await page.getByLabel('格式', { exact: true }).selectOption('png');
    await page.getByLabel('DPI（72-300）').fill('150');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible({ timeout: 60000 });
    await saveDownload(page, 'ZIP 打包下载', M('p2i-png150.zip'));
  });

  test('PDF→JPEG 质量 0.5 + 页范围 1-2（ZIP）', async ({ page }) => {
    ensureFixtures(); await openTool(page, 'pdf2images');
    await upload(page, ['multi8.pdf'], false);
    await page.getByLabel('格式', { exact: true }).selectOption('jpeg');
    await page.getByLabel('JPEG 质量（0.05-1，仅 JPEG 生效）').fill('0.5');
    await page.getByLabel('页范围').fill('1-2');
    await page.getByRole('button', { name: '开始转换' }).click();
    await expect(page.getByText('转换完成')).toBeVisible({ timeout: 60000 });
    await saveDownload(page, 'ZIP 打包下载', M('p2i-jpeg-q05.zip'));
  });

  test('提取图像：raw 原样输出（SMask 文档）', async ({ page }) => {
    ensureFixtures(); await openTool(page, 'extractimages');
    await upload(page, ['smask_alpha.pdf'], false);
    await page.locator('input[name="extract-mode"][value="raw"]').check();
    await page.getByRole('button', { name: '开始提取' }).click();
    await expect(page.locator('.result-artifact, .card').filter({ hasText: /提取完成|来源第/ }).first()).toBeVisible({ timeout: 30000 });
    await saveDownload(page, 'ZIP 打包下载', M('extract-raw.zip'));
  });

  test('提取图像：composite 合成透明', async ({ page }) => {
    ensureFixtures(); await openTool(page, 'extractimages');
    await upload(page, ['smask_alpha.pdf'], false);
    await page.locator('input[name="extract-mode"][value="composite"]').check();
    await page.getByRole('button', { name: '开始提取' }).click();
    await expect(page.locator('.result-artifact, .card').filter({ hasText: /提取完成|来源第/ }).first()).toBeVisible({ timeout: 30000 });
    await saveDownload(page, 'ZIP 打包下载', M('extract-composite.zip'));
  });
});

test.describe('选项矩阵：compare 比较', () => {
  test('差异阈值 30：multi8 vs multi3 渲染像素 diff 视图', async ({ page }) => {
    ensureFixtures(); await openTool(page, 'compare');
    await upload(page, ['multi8.pdf'], false);
    await upload(page, ['multi3.pdf'], true, 1);
    await page.getByLabel('差异阈值（0-100）').fill('30');
    await page.getByRole('button', { name: '开始比较' }).click();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60000 });
  });
});
