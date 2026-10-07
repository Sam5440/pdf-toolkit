// 常用小功能批次 e2e：识别二维码 / 哈希计算 / 文本加解密 / 图片 OCR / 文件床
// 文件床上传在测试中拦截 mock（不触真实第三方服务）。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { openTool, upload, saveDownload, ensureFixtures, ARTIFACTS } from './helpers.js';

test.beforeAll(() => ensureFixtures());

test.describe('识别二维码', () => {
  test('生成 → 下载 → 上传识别 往返（中文内容）', async ({ page }) => {
    const content = 'https://example.com/中文往返-42';
    // 先用「生成二维码」产出含中文的真实 PNG
    await openTool(page, 'qrcode');
    await page.locator('[data-qr-text]').fill(content);
    await page.getByRole('button', { name: '生成二维码' }).click();
    await expect(page.locator('[data-qr-preview] canvas')).toBeVisible();
    const png = await saveDownload(page, '下载', 'qrcode-cn.png');
    expect(fs.statSync(png).size).toBeGreaterThan(200);

    // 再用「识别二维码」上传识别
    await openTool(page, 'qrcode-scan');
    await upload(page, [png]);
    await page.getByRole('button', { name: '开始识别' }).click();
    await expect(page.getByText(content)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '复制' })).toBeVisible();
  });

  test('边界：无文件禁用；非二维码图片给出明确错误', async ({ page }) => {
    await openTool(page, 'qrcode-scan');
    await expect(page.getByRole('button', { name: '开始识别' })).toBeDisabled();
    await upload(page, ['photo_l.jpg']);
    await page.getByRole('button', { name: '开始识别' }).click();
    await expect(page.getByText('未在图片中找到二维码')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('哈希计算', () => {
  test('文本模式：hello 的 MD5/SHA-256 标准值', async ({ page }) => {
    await openTool(page, 'hash-calc');
    await page.locator('[data-hash-text]').fill('hello');
    await page.getByRole('button', { name: '计算哈希' }).click();
    await expect(page.getByText('5d41402abc4b2a76b9719d911017c592')).toBeVisible();
    await expect(page.getByText('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')).toBeVisible();
  });

  test('文件模式：sample.txt 四种算法均为 hex 摘要', async ({ page }) => {
    await openTool(page, 'hash-calc');
    await page.locator('[data-hash-mode]').selectOption('file');
    await upload(page, ['sample.txt']);
    await page.getByRole('button', { name: '计算哈希' }).click();
    await expect(page.locator('.result-artifact')).toHaveCount(4);
    const md5Row = page.locator('.result-artifact').filter({ hasText: 'MD5' }).first();
    await expect(md5Row).toContainText(/[0-9a-f]{32}/);
    await expect(page.locator('.result-artifact').filter({ hasText: 'SHA-512' })).toContainText(/[0-9a-f]{128}/);
  });

  test('边界：空文本点计算 → toast 提示', async ({ page }) => {
    await openTool(page, 'hash-calc');
    await page.getByRole('button', { name: '计算哈希' }).click();
    await expect(page.locator('.toast-error')).toHaveText(/请输入文本/, { timeout: 5_000 });
  });
});

test.describe('文本加解密', () => {
  test('AES 加密 → 同钥解密往返；输出与输入不同', async ({ page }) => {
    await openTool(page, 'crypt');
    const msg = '机密内容 secret-42！';
    await page.locator('[data-crypt-in]').fill(msg);
    await page.locator('[data-crypt-key]').fill('k1');
    await page.getByRole('button', { name: '执行加解密' }).click();
    const out = await page.locator('[data-crypt-out]').textContent();
    expect(out).toBeTruthy();
    expect(out).not.toContain(msg);
    expect(out).toContain('U2FsdGVk'); // OpenSSL Salted__ 头的 Base64 形态

    // 解密往返
    await page.locator('[data-crypt-in]').fill(out);
    await page.locator('[data-crypt-mode]').selectOption('dec');
    await page.getByRole('button', { name: '执行加解密' }).click();
    await expect(page.locator('[data-crypt-out]')).toHaveText(msg);
  });

  test('Base64 编解码往返', async ({ page }) => {
    await openTool(page, 'crypt');
    await page.locator('[data-crypt-in]').fill('hello base64');
    await page.locator('[data-crypt-algo]').selectOption('base64');
    await page.getByRole('button', { name: '执行加解密' }).click();
    await expect(page.locator('[data-crypt-out]')).toHaveText('aGVsbG8gYmFzZTY0');

    await page.locator('[data-crypt-in]').fill('aGVsbG8gYmFzZTY0');
    await page.locator('[data-crypt-mode]').selectOption('dec');
    await page.getByRole('button', { name: '执行加解密' }).click();
    await expect(page.locator('[data-crypt-out]')).toHaveText('hello base64');
  });

  test('边界：错误密钥解密 → 明确错误提示', async ({ page }) => {
    await openTool(page, 'crypt');
    await page.locator('[data-crypt-in]').fill('Salted__whatever');
    await page.locator('[data-crypt-key]').fill('wrong');
    await page.locator('[data-crypt-mode]').selectOption('dec');
    await page.getByRole('button', { name: '执行加解密' }).click();
    await expect(page.getByText('解密失败：密钥错误或密文格式不正确')).toBeVisible();
  });
});

test.describe('图片文字识别', () => {
  test('上传图片 → 识别完成产出 TXT', async ({ page }) => {
    test.setTimeout(240_000); // 首次加载 tesseract 引擎与语言包较慢
    await openTool(page, 'imgocr');
    await upload(page, ['photo_l.jpg']);
    await page.getByRole('button', { name: '开始识别' }).click();
    await expect(page.getByText('处理完成')).toBeVisible({ timeout: 220_000 });
    const p = await saveDownload(page, '下载', 'imgocr-out.txt');
    expect(fs.existsSync(p)).toBe(true);
  });

  test('边界：无文件禁用；取消语言全选 → toast', async ({ page }) => {
    await openTool(page, 'imgocr');
    await expect(page.getByRole('button', { name: '开始识别' })).toBeDisabled();
    await upload(page, ['photo_l.jpg']);
    for (const lang of ['简体中文', '英文']) {
      await page.getByRole('checkbox', { name: lang }).uncheck();
    }
    await page.getByRole('button', { name: '开始识别' }).click();
    await expect(page.locator('.toast-error')).toHaveText(/至少选择一种语言/, { timeout: 5_000 });
  });
});

test.describe('文件床', () => {
  test('上传 → mock 服务返回链接 → 展示与复制入口', async ({ page }) => {
    await openTool(page, 'filebed');
    await page.route('**/upload', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: 'https://src.yohuo.eu.org/e2e-mock-alpha.png' }),
    }));
    await upload(page, ['alpha.png']);
    await page.getByRole('button', { name: '上传到文件床' }).click();
    await expect(page.getByText('https://src.yohuo.eu.org/e2e-mock-alpha.png')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: '复制链接' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Markdown' })).toBeVisible();
    await expect(page.getByText('成功 1/1')).toBeVisible();
  });

  test('网络中断 → CORS/网络帮助指引出现', async ({ page }) => {
    await openTool(page, 'filebed');
    await page.route('**/upload', (route) => route.abort('failed'));
    await upload(page, ['alpha.png']);
    await page.getByRole('button', { name: '上传到文件床' }).click();
    await expect(page.getByText(/跨域 CORS 限制/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/自部署 telegraph 实例/)).toBeVisible();
  });

  test('边界：不支持的扩展名 → 面板拒收且不发起上传', async ({ page }) => {
    await openTool(page, 'filebed');
    let called = 0;
    await page.route('**/upload', (route) => { called += 1; return route.fulfill({ status: 200, body: '{}' }); });
    await upload(page, ['sample.txt']);
    await expect(page.locator('.toast-error')).toHaveText(/不支持的文件类型/, { timeout: 5_000 });
    await expect(page.getByRole('button', { name: '上传到文件床' })).toBeDisabled();
    expect(called).toBe(0);
  });
});
