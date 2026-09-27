// 密码保护 e2e：加密（pypdf 交叉验证）+ 错误密码内联提示 + 解密移除
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ensureFixtures, openTool, upload, saveDownload, ARTIFACTS, FIXTURES } from './helpers.js';

/** 上传到指定输入面板（security 有加密/解密两个面板，nth 选择可见面板） */
async function uploadTo(page, nth, files) {
  const chooserP = page.waitForEvent('filechooser');
  await page.locator('.dropzone').nth(nth).click();
  const chooser = await chooserP;
  await chooser.setFiles(files.map((f) => (path.isAbsolute(f) ? f : path.join(FIXTURES, f))));
  await page.waitForTimeout(400);
}

test.describe('security 工具', () => {
  test.beforeEach(() => ensureFixtures());

  test('加密链路：设置打开密码 → 产物 pypdf 验证已加密且可解', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'security');
    await uploadTo(page, 0, ['multi3.pdf']);
    const pws = page.locator('input[type=password]');
    await pws.nth(0).fill('test123');
    await pws.nth(1).fill('test123');
    await page.getByRole('button', { name: '开始加密' }).click();
    await page.getByRole('button', { name: '下载', exact: true }).waitFor({ timeout: 60_000 });

    const p = await saveDownload(page, '下载', 'enc-out.pdf');
    expect(fs.statSync(p).size).toBeGreaterThan(0);
    // python 独立交叉验证（浏览器生产、python 验证）
    const out = execSync(
      `python3 -c "from pypdf import PdfReader; r=PdfReader('${p}'); enc=r.is_encrypted; r.decrypt('test123') if enc else None; print(enc, len(r.pages))"`,
    ).toString();
    expect(out.trim()).toMatch(/^True \d+$/);
  });

  test('边界：两次密码不一致 → 内联错误，不执行', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'security');
    await uploadTo(page, 0, ['multi3.pdf']);
    const pws = page.locator('input[type=password]');
    await pws.nth(0).fill('test123');
    await pws.nth(1).fill('test124');
    await page.getByRole('button', { name: '开始加密' }).click();
    await expect(page.getByText('两次输入的打开密码不一致')).toBeVisible();
    await expect(page.getByRole('button', { name: '下载', exact: true })).toHaveCount(0);
  });

  test('边界：密码含逗号 → 引擎限制提示', async ({ page }) => {
    test.setTimeout(60_000);
    await openTool(page, 'security');
    await uploadTo(page, 0, ['multi3.pdf']);
    const pws = page.locator('input[type=password]');
    await pws.nth(0).fill('a,b');
    await pws.nth(1).fill('a,b');
    await page.getByRole('button', { name: '开始加密' }).click();
    await expect(page.getByText('不能包含英文逗号或等号')).toBeVisible();
  });

  test('解密链路：错误密码内联报错；正确密码移除加密（pypdf 验证）', async ({ page }) => {
    test.setTimeout(120_000);
    await openTool(page, 'security');
    await page.getByRole('button', { name: '移除密码 / 解密' }).click();
    await uploadTo(page, 1, ['enc_user123.pdf']);
    await page.locator('input[type=password]').last().fill('wrongpw');
    await page.getByRole('button', { name: '开始解密（移除密码）' }).click();
    await expect(page.getByText('密码错误或文件损坏')).toBeVisible({ timeout: 60_000 });

    // 正确密码
    await page.locator('input[type=password]').last().fill('user123');
    await page.getByRole('button', { name: '开始解密（移除密码）' }).click();
    await page.getByRole('button', { name: '下载', exact: true }).waitFor({ timeout: 60_000 });
    const p = await saveDownload(page, '下载', 'dec-out.pdf');
    const out = execSync(
      `python3 -c "from pypdf import PdfReader; r=PdfReader('${p}'); print(r.is_encrypted, len(r.pages))"`,
    ).toString();
    expect(out.trim()).toMatch(/^False \d+$/);
  });
});
