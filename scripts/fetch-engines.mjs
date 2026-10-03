#!/usr/bin/env node
// 重建重型 WASM 引擎资产到 public/engines/ 与 public/fonts/typst/（.gitignore，不进 git；dist 构建时随 public/ 拷贝）。
// 当前引擎：
//   - pandoc.wasm（pandoc 3.10，来自 pandoc-wasm@1.1.0 npm 包，GPL-2.0+）
//     来源优先级：node_modules/pandoc-wasm/src/pandoc.wasm → npm tarball 下载
//   - typst_ts_web_compiler_bg.wasm（typst.ts 0.7.0，Apache-2.0，28.3MB）
//   - Typst 配套字体（typst-assets v0.13.1）：NewCMMath-{Regular,Book}.otf、DejaVuSansMono{,-Bold}.ttf
// 用法：node scripts/fetch-engines.mjs
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPST_ASSETS = 'https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.13.1/files/fonts';
const TYPST_COMPILER_TGZ = 'https://registry.npmjs.org/@myriaddreamin/typst-ts-web-compiler/-/typst-ts-web-compiler-0.7.0.tgz';

const jobs = [];
function sizeOf(p) { try { return statSync(p).size; } catch { return -1; } }

async function fetchTo(url, dest, minBytes) {
  if (sizeOf(dest) >= minBytes) { jobs.push(`跳过 ${dest}`); return; }
  mkdirSync(dirname(dest), { recursive: true });
  console.log(`[fetch-engines] 下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} : ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  if (sizeOf(dest) < minBytes) throw new Error(`体积异常 ${dest}`);
  jobs.push(`完成 ${dest}`);
}

// ---- pandoc.wasm ----
async function ensurePandoc() {
  const destDir = join(root, 'public', 'engines', 'pandoc');
  const dest = join(destDir, 'pandoc.wasm');
  const MIN = 50 * 1024 * 1024;
  if (sizeOf(dest) >= MIN) { jobs.push(`跳过 ${dest}`); return; }
  mkdirSync(destDir, { recursive: true });
  const src = join(root, 'node_modules', 'pandoc-wasm', 'src', 'pandoc.wasm');
  if (sizeOf(src) >= MIN) {
    await copyFile(src, dest);
    jobs.push(`复制 ${dest}`);
    return;
  }
  console.log('[fetch-engines] 下载 pandoc-wasm tarball (~16MB)…');
  const res = await fetch('https://registry.npmjs.org/pandoc-wasm/-/pandoc-wasm-1.1.0.tgz');
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  const tgz = join(destDir, 'pandoc-wasm.tgz');
  await writeFile(tgz, Buffer.from(await res.arrayBuffer()));
  rm(join(destDir, 'pkg'), { recursive: true, force: true });
  execFileSync('tar', ['-xzf', tgz, '-C', destDir, 'package/src/pandoc.wasm']);
  await copyFile(join(destDir, 'package', 'src', 'pandoc.wasm'), dest);
  rm(join(destDir, 'package'), { recursive: true, force: true });
  rm(tgz, { force: true });
  if (sizeOf(dest) < MIN) throw new Error('pandoc.wasm 校验失败');
  jobs.push(`完成 ${dest}`);
}

// ---- typst compiler wasm ----
async function ensureTypst() {
  const destDir = join(root, 'public', 'engines', 'typst');
  const dest = join(destDir, 'typst_ts_web_compiler_bg.wasm');
  if (sizeOf(dest) >= 25 * 1024 * 1024) { jobs.push(`跳过 ${dest}`); return; }
  mkdirSync(destDir, { recursive: true });
  const src = join(root, 'node_modules', '@myriaddreamin', 'typst-ts-web-compiler', 'pkg', 'typst_ts_web_compiler_bg.wasm');
  if (sizeOf(src) >= 25 * 1024 * 1024) {
    await copyFile(src, dest);
    jobs.push(`复制 ${dest}`);
    return;
  }
  console.log('[fetch-engines] 下载 typst-ts-web-compiler tarball (~11MB)…');
  const res = await fetch(TYPST_COMPILER_TGZ);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tgz = join(destDir, 'typst.tgz');
  await writeFile(tgz, Buffer.from(await res.arrayBuffer()));
  rm(join(destDir, 'pkg'), { recursive: true, force: true });
  execFileSync('tar', ['-xzf', tgz, '-C', destDir, 'package/pkg/typst_ts_web_compiler_bg.wasm']);
  await copyFile(join(destDir, 'package', 'pkg', 'typst_ts_web_compiler_bg.wasm'), dest);
  rm(join(destDir, 'package'), { recursive: true, force: true });
  rm(tgz, { force: true });
  if (sizeOf(dest) < 25 * 1024 * 1024) throw new Error('typst wasm 校验失败');
  jobs.push(`完成 ${dest}`);
}

async function ensureTypstFonts() {
  const dir = join(root, 'public', 'fonts', 'typst');
  await fetchTo(`${TYPST_ASSETS}/NewCMMath-Regular.otf`, join(dir, 'NewCMMath-Regular.otf'), 500 * 1024);
  await fetchTo(`${TYPST_ASSETS}/NewCMMath-Book.otf`, join(dir, 'NewCMMath-Book.otf'), 500 * 1024);
  await fetchTo(`${TYPST_ASSETS}/DejaVuSansMono.ttf`, join(dir, 'DejaVuSansMono.ttf'), 200 * 1024);
  await fetchTo(`${TYPST_ASSETS}/DejaVuSansMono-Bold.ttf`, join(dir, 'DejaVuSansMono-Bold.ttf'), 200 * 1024);
}

const main = async () => {
  if (!existsSync(join(root, 'public', 'engines'))) mkdirSync(join(root, 'public', 'engines'), { recursive: true });
  await ensurePandoc();
  await ensureTypst();
  await ensureTypstFonts();
  for (const j of jobs) console.log(`[fetch-engines] ${j}`);
};

main().catch((err) => { console.error('[fetch-engines] 失败:', err.message); process.exit(1); });

