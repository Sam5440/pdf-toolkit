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
  test('默认 onlyfiles 上传 → mock 直传服务返回链接（无嵌入按钮，有分享页说明）', async ({ page }) => {
    await openTool(page, 'filebed');
    await page.route('**/upload', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: true,
        data: { file: { url: { full: 'https://onlyfiles.com/e2emock01/alpha.png', short: 'https://onlyfiles.com/e2emock01' } } },
      }),
    }));
    await expect(page.getByLabel('上传服务')).toHaveValue('onlyfiles');
    await upload(page, ['alpha.png']);
    await page.getByRole('button', { name: '上传到文件床' }).click();
    await expect(page.getByText('https://onlyfiles.com/e2emock01/alpha.png')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: '复制链接' })).toBeVisible();
    // onlyfiles 分享链接为预览页（直链站方动态签名），不提供 Markdown/HTML 嵌入入口
    await expect(page.getByRole('button', { name: 'Markdown' })).toHaveCount(0);
    await expect(page.getByText(/永久托管/).first()).toBeVisible();
    await expect(page.getByText('成功 1/1')).toBeVisible();
  });

  test('yohuo 直连网络中断 → CORS 指引含 onlyfiles 建议与 Worker 代码', async ({ page }) => {
    await openTool(page, 'filebed');
    await page.getByLabel('上传服务').selectOption('yohuo');
    await page.route('**/upload', (route) => route.abort('failed'));
    await upload(page, ['alpha.png']);
    await page.getByRole('button', { name: '上传到文件床' }).click();
    await expect(page.getByText(/跨域 CORS 限制/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/onlyfiles\.com 或 tmpfiles\.org/)).toBeVisible();
    await expect(page.getByRole('button', { name: '复制 Worker 代码' })).toBeVisible();
  });

  test('边界：yohuo 白名单外扩展名 → 点上传时 toast 拒收且不发起请求', async ({ page }) => {
    await openTool(page, 'filebed');
    await page.getByLabel('上传服务').selectOption('yohuo');
    let called = 0;
    await page.route('**/upload', (route) => { called += 1; return route.fulfill({ status: 200, body: '{}' }); });
    await upload(page, ['sample.txt']); // 宽松 acceptTest 下 txt 可进面板，白名单在执行时校验
    await page.getByRole('button', { name: '上传到文件床' }).click();
    await expect(page.locator('.toast-error')).toHaveText(/不支持的文件类型/, { timeout: 5_000 });
    expect(called).toBe(0);
  });
});

test.describe('图床（GitHub）', () => {
  const RAW_URL = 'https://raw.githubusercontent.com/e2e-owner/e2e-repo/main/pdftoolkit/alpha.png';

  async function mockGithub(page) {
    await page.route('**/api.github.com/repos/e2e-owner/e2e-repo/contents/**', (route) => route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ content: { download_url: RAW_URL } }),
    }));
  }

  test('GitHub 图床：填仓库与 token → 上传 → 多格式链接 + 写入上传记录', async ({ page }) => {
    await openTool(page, 'image-bed');
    await mockGithub(page);
    await expect(page.getByLabel('图床服务')).toHaveValue('github');
    await page.getByLabel('GitHub 用户 / 组织').fill('e2e-owner');
    await page.getByLabel('仓库名').fill('e2e-repo');
    await page.getByLabel('访问令牌（token）').fill('e2e-token-ghp');
    await upload(page, ['alpha.png']);
    await page.getByRole('button', { name: '上传到图床' }).click();
    await expect(page.getByText(RAW_URL)).toBeVisible({ timeout: 15_000 });
    // 多格式复制入口：链接 / Markdown / HTML / BBCode
    await expect(page.getByRole('button', { name: 'Markdown', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'HTML', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'BBCode', exact: true })).toBeVisible();
    await expect(page.getByText('成功 1/1')).toBeVisible();
    // 上传记录页能查到该条（含 GitHub host）
    await page.goto('/#/uploads');
    await expect(page.getByText('alpha.png').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(RAW_URL).first()).toBeVisible();
  });

  test('边界：GitHub 未填 token/仓库 → 明确报错不上传', async ({ page }) => {
    await openTool(page, 'image-bed');
    await mockGithub(page);
    let called = 0;
    await page.route('**/api.github.com/**', (route) => { called += 1; return route.fulfill({ status: 201, body: '{}' }); });
    await upload(page, ['alpha.png']);
    await page.getByRole('button', { name: '上传到图床' }).click();
    await expect(page.locator('.toast-error')).toHaveText(/请先填写 GitHub 用户名与仓库名/, { timeout: 5_000 });
    expect(called).toBe(0);
  });

  test('边界：非图片扩展名拒收', async ({ page }) => {
    await openTool(page, 'image-bed');
    await upload(page, ['sample.txt']); // 面板 acceptTest 白名单静默拒收 txt
    await expect(page.getByRole('button', { name: '上传到图床' })).toBeDisabled();
  });
});

test.describe('上传记录页', () => {
  async function uploadViaFilebed(page) {
    const URL_UP = 'https://onlyfiles.com/e2emock01/beta.png';
    await openTool(page, 'filebed');
    await page.route('**/upload', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: true,
        data: { file: { url: { full: URL_UP, short: 'https://onlyfiles.com/e2emock01' } } },
      }),
    }));
    await upload(page, ['alpha.png']);
    await page.getByRole('button', { name: '上传到文件床' }).click();
    await expect(page.getByText(URL_UP)).toBeVisible({ timeout: 15_000 });
    return URL_UP;
  }

  test('列表/多格式复制/检测：有效与失效两态', async ({ page }) => {
    const upUrl = await uploadViaFilebed(page);
    await page.goto('/');
    await page.locator('a.side-link[href="#/uploads"]').click(); // hash 点击非整页跳转
    await expect(page.getByText('beta.png')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Markdown', exact: true }).first()).toBeVisible();
    // 探测走 Image 元素加载：route mock GET 200 → 有效
    await page.route('**/onlyfiles.com/e2emock01/beta.png*', (route) => route.fulfill({
      status: 200, contentType: 'image/png', body: fs.readFileSync('tests/fixtures/out/alpha.png'),
    }));
    await page.getByRole('button', { name: '检测全部上传链接' }).click();
    await expect(page.getByText('有效', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('检测完成：1 有效 · 0 失效 · 0 无法判定')).toBeVisible();
  });

  test('失效检测：404 → 已失效徽标；删除记录需确认', async ({ page }) => {
    await uploadViaFilebed(page);
    await page.goto('/');
    await page.locator('a.side-link[href="#/uploads"]').click();
    await expect(page.getByText('beta.png')).toBeVisible({ timeout: 10_000 });
    await page.route('**/onlyfiles.com/e2emock01/beta.png*', (route) => route.fulfill({ status: 404, body: 'gone' }));
    await page.getByRole('button', { name: '检测全部上传链接' }).click();
    await expect(page.getByText('已失效', { exact: true })).toBeVisible({ timeout: 20_000 });
    // 删除：确认后列表清空
    await page.getByRole('button', { name: '删除记录：alpha.png' }).click();
    await page.getByRole('button', { name: '删除', exact: true }).last().click();
    await expect(page.getByText(/暂无上传记录/)).toBeVisible({ timeout: 10_000 });
  });

  test('空态引导 + 侧边栏入口可见', async ({ page }) => {
    await page.goto('/');
    await page.locator('a.side-link[href="#/uploads"]').click();
    await expect(page.getByText(/暂无上传记录/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: '检测全部上传链接' })).toBeVisible();
  });
});
