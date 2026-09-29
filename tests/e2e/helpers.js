// e2e 公共 helper（F 拥有；各代理只读使用）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const FIXTURES = path.join(ROOT, 'tests/fixtures/out');
export const ARTIFACTS = path.join(ROOT, 'tests/e2e/.artifacts');

/** 确保合成夹具已生成（幂等） */
export function ensureFixtures() {
  if (!fs.existsSync(path.join(FIXTURES, 'multi3.pdf'))) {
    execSync('python3 scripts/build_fixtures.py', { cwd: ROOT, stdio: 'inherit' });
  }
  fs.mkdirSync(ARTIFACTS, { recursive: true });
}

/** 打开指定工具页（契约：真实点击侧边导航） */
export async function openTool(page, toolId) {
  await page.goto('/');
  await page.locator(`a.side-link[href="#/tool/${toolId}"]`).waitFor();
  await page.locator(`a.side-link[href="#/tool/${toolId}"]`).click();
  await page.waitForTimeout(250);
}

/** 真实文件上传（走 filechooser，禁止 DOM 注入）；zone 指定第几个 dropzone（多面板工具用） */
export async function upload(page, files, multiple = true, zone = 0) {
  const chooserP = page.waitForEvent('filechooser');
  await page.locator('.dropzone').nth(zone).click();
  const chooser = await chooserP;
  await chooser.setFiles(files.map((f) => (path.isAbsolute(f) ? f : path.join(FIXTURES, f))));
  await page.waitForTimeout(400);
}

/** 等待下载并保存到 .artifacts，返回绝对路径 */
export async function saveDownload(page, buttonName, saveName) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const dlP = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: buttonName }).first().click();
  const dl = await dlP;
  const dest = path.join(ARTIFACTS, saveName);
  await dl.saveAs(dest);
  return dest;
}
