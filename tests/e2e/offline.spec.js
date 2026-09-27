// 离线独立运行验证：后端仅静态服务的情况下，前端 WASM 处理是否零网络依赖。
// 严格场景：在线预热后 context.setOffline(true) 模拟后端关闭，页面保持打开，
// 之后全部通过 SPA 哈希导航切换工具（无整页重载、无任何网络机会），
// 用"新上传的文件"完成真实处理与下载。
// 断网期间出现任何请求尝试（requestfailed）即判定失败。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ensureFixtures, openTool, upload, saveDownload, ARTIFACTS } from './helpers.js';

/** 断网状态下的工具切换：纯哈希导航（SPA 内部路由，不发请求） */
async function openToolOffline(page, toolId) {
  await page.locator(`a.side-link[href="#/tool/${toolId}"]`).click();
  await page.waitForTimeout(250);
}

test('断网后核心功能独立完成真实处理（严格：无任何网络请求）', async ({ page, context }) => {
  test.setTimeout(300_000);
  ensureFixtures();

  const offlineFailures = [];
  let offline = false;
  page.on('requestfailed', (r) => {
    if (offline) offlineFailures.push(`${r.method()} ${r.url()}`);
  });

  // ---------- 在线预热：懒加载引擎 worker / pdf.js / pdf-lib 等分块 ----------
  await openTool(page, 'merge');
  await upload(page, ['multi3.pdf', 'multi3.pdf']);
  await page.getByRole('button', { name: '开始合并' }).click();
  await page.getByRole('button', { name: '下载合并结果' }).waitFor({ timeout: 60_000 });

  await openTool(page, 'pdf2images');
  await upload(page, ['multi3.pdf']);
  await page.getByRole('button', { name: '开始转换' }).click();
  await page.getByRole('button', { name: 'ZIP 打包下载' }).waitFor({ timeout: 90_000 });

  // ---------- 后端关闭（断网），页面保持打开 ----------
  await context.setOffline(true);
  offline = true;

  // 合并：全新上传 + 处理 + 下载
  await openToolOffline(page, 'merge');
  await upload(page, ['multi3.pdf', 'multi3.pdf']);
  await page.getByRole('button', { name: '开始合并' }).click();
  const p1 = await saveDownload(page, '下载合并结果', 'merge-offline.pdf');
  expect(fs.statSync(p1).size).toBeGreaterThan(0);

  // PDF 转图片：pdf.js 渲染路径
  await openToolOffline(page, 'pdf2images');
  await upload(page, ['multi3.pdf']);
  await page.getByRole('button', { name: '开始转换' }).click();
  const p2 = await saveDownload(page, 'ZIP 打包下载', 'pdf2images-offline.zip');
  expect(fs.statSync(p2).size).toBeGreaterThan(0);

  // 图片转 PDF：pdf-lib 结构操作
  await openToolOffline(page, 'images2pdf');
  await upload(page, ['photo_l.jpg', 'alpha.png']);
  await page.getByRole('button', { name: '开始转换' }).click();
  const p3 = await saveDownload(page, '下载', 'images2pdf-offline.pdf');
  expect(fs.statSync(p3).size).toBeGreaterThan(0);

  // 提取嵌入图像：引擎提取 + 主线程兜底
  await openToolOffline(page, 'extractimages');
  await upload(page, ['smask_alpha.pdf']);
  await page.getByRole('button', { name: '开始提取' }).click();
  const p4 = await saveDownload(page, 'ZIP 打包下载', 'extract-offline.zip');
  expect(fs.statSync(p4).size).toBeGreaterThan(0);

  // 断网期间不允许出现任何网络请求（出现即说明处理或 UI 不独立）
  expect(offlineFailures, `断网期间尝试了网络请求：${offlineFailures.join(', ')}`).toEqual([]);

  fs.writeFileSync(
    path.join(ARTIFACTS, 'offline-result.json'),
    JSON.stringify(
      {
        ok: true,
        offlineRequestAttempts: offlineFailures,
        artifacts: [p1, p2, p3, p4].map((p) => ({ file: path.basename(p), bytes: fs.statSync(p).size })),
      },
      null,
      2,
    ),
  );
});
