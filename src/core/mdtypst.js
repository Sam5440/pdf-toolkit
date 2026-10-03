// Typst 排版引擎（WASM）：Markdown → PDF（杂志级排版，浏览器内编译，文件不出浏览器）。
// 链路：pandoc（md → typst 源）+ typst.ts 0.7.0（typst 0.14.2 编译器 wasm → PDF bytes）。
// - wasm：public/engines/typst/typst_ts_web_compiler_bg.wasm（28.3MB，fetch-engines 重建）
// - 字体：public/fonts/text/NotoSansSC-*.ttf（GB2312+常用符号子集，2.2MB/字重）
//         public/fonts/typst/NewCMMath-*.otf（数学）、DejaVuSansMono*.ttf（等宽）
// 禁用 typst.ts 默认远程字体资产（离线）；Java/Kotlin 未涉及。COOP/COEP 非必需（单线程）。
import { $typst } from '@myriaddreamin/typst.ts';
import { loadFonts, disableDefaultFontAssets } from '@myriaddreamin/typst.ts/options.init';
import { pandocToTypst, getPandoc } from './mdpandoc.js';

// 资产基址惰性求值（模块可能被 node 环境测试链路引入，不能在顶层触碰 document）
const fontUrl = (name) => new URL(`fonts/${name}`, document.baseURI).href;
const engineUrl = (name) => new URL(`engines/typst/${name}`, document.baseURI).href;

let initDone = false;
let initPromise = null;

const PAPERS = {
  a4: '"a4"', letter: '"us-letter"', a5: '"a5"', a3: '"a3"', legal: '"us-legal"',
};

/** 引擎 wasm 预取（带重试 + 进度），bytes 直接喂给 getModule（同时获得下载进度可见性）。
 *  404 同样重试——vite build 清空 dist 的数秒窗口内会短暂 404，别误报"文件缺失"。 */
async function fetchWasm(url, onProgress) {
  for (let attempt = 0; ; attempt++) {
    let notFound = false;
    try {
      const res = await fetch(url);
      if (res.status === 404) { notFound = true; throw new TypeError('404'); }
      if (!res.ok) throw new Error(`Typst 引擎加载失败：HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress?.(loaded, total);
      }
      const out = new Uint8Array(loaded);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } catch (err) {
      if (!(notFound || err instanceof TypeError)) throw err;
      if (attempt >= (notFound ? 2 : 1)) {
        if (notFound) {
          throw new Error('Typst 引擎文件未找到：若刚重建/重启过站点请刷新页面后重试；若持续出现，请运行 node scripts/fetch-engines.mjs');
        }
        throw new Error(`Typst 引擎下载失败（已重试）：${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

async function ensureTypst(onStage) {
  if (initDone) return;
  if (!initPromise) {
    initPromise = (async () => {
      const wasmBytes = await fetchWasm(engineUrl('typst_ts_web_compiler_bg.wasm'), (loaded, total) => {
        onStage?.(`下载 Typst 引擎 ${(loaded / 1048576).toFixed(0)}MB / ${(total / 1048576).toFixed(0)}MB（首次加载，之后走浏览器缓存）…`);
      });
      onStage?.('初始化 Typst 编译器…');
      $typst.setCompilerInitOptions({
        getModule: () => wasmBytes,
        beforeBuild: [
          disableDefaultFontAssets(), // 禁 jsdelivr 远程字体（离线）
          loadFonts([
            fontUrl('text/NotoSansSC-Regular-Text.ttf'),
            fontUrl('text/NotoSansSC-Bold-Text.ttf'),
            fontUrl('typst/NewCMMath-Regular.otf'),
            fontUrl('typst/NewCMMath-Book.otf'),
            fontUrl('typst/DejaVuSansMono.ttf'),
            fontUrl('typst/DejaVuSansMono-Bold.ttf'),
          ]),
        ],
      });
      // 触发一次极小编译完成全部惰性初始化（wasm + 字体）
      const ok = await $typst.pdf({ mainContent: '#set page(width: 10pt, height: 10pt, margin: 0pt)\nX' });
      if (!ok || !ok.length) throw new Error('Typst 引擎自检失败');
      initDone = true;
    })().catch((err) => { initPromise = null; throw err; });
  }
  return initPromise;
}

/** pandoc 版纸张/字号 → typst 版式头 */
function preamble({ paper = 'a4', fontSize = 11 }) {
  const p = PAPERS[paper] ?? PAPERS.a4;
  const pt = Number(fontSize) || 11;
  // 页边距对齐内置引擎 48pt ≈ 1.69cm；行距 1.6；中英文混排
  return [
    '#set page(paper: ' + p + ', margin: (x: 1.69cm, y: 1.69cm), numbering: none)',
    '#set text(font: "Noto Sans SC", size: ' + pt + 'pt, lang: "zh", region: "cn", top-edge: "cap-height", bottom-edge: "baseline")',
    '#set par(justify: false, leading: 0.72em, spacing: 1.1em)',
    '#show math.equation: set text(font: "New Computer Modern Math")', // typst 0.14（0.15 起才叫 math.formula）
    '#show raw: set text(font: "DejaVu Sans Mono", size: 0.92em)',
    '#show raw.where(block: true): block.with(fill: rgb("#f3f4f6"), inset: 8pt, radius: 4pt, width: 100%, breakable: true)',
    '#show quote: set block(fill: rgb("#f8fafc"), inset: (x: 8pt, y: 5pt))',
    '#show link: set text(fill: rgb(37, 99, 235))',
    // 标题层级视觉（对齐内置引擎 2.0/1.55/1.25×）
    '#show heading.where(level: 1): set text(size: ' + (pt * 2.0).toFixed(1) + 'pt)',
    '#show heading.where(level: 2): set text(size: ' + (pt * 1.55).toFixed(1) + 'pt)',
    '#show heading.where(level: 3): set text(size: ' + (pt * 1.25).toFixed(1) + 'pt)',
    '#show heading: set block(above: 1.3em, below: 0.8em)',
  ].join('\n');
}

/**
 * Markdown → PDF bytes（Typst 排版）。
 * onStage(stageText) / onPct(0..1) 汇报进度。返回 { bytes, warnings? }。
 */
export async function markdownToPdfTypst(markdown, { paper, fontSize, title, onStage } = {}) {
  onStage?.('准备 pandoc 引擎…');
  // 提前确保 pandoc 已就绪（复用同一实例）
  await getPandoc({ onStage });
  const { source } = await pandocToTypst(markdown, { onStage });
  onStage?.('准备 Typst 引擎（首次约 28MB）…');
  await ensureTypst(onStage);
  onStage?.('Typst 编译 PDF…');
  const head = preamble({ paper, fontSize });
  const doc = title ? `#set document(title: ${JSON.stringify(title)})\n${head}\n${source}` : `${head}\n${source}`;
  let bytes;
  try {
    bytes = await $typst.pdf({ mainContent: doc });
  } catch (err) {
    const msg = String(err?.message || err);
    throw new Error(`Typst 编译失败：${msg.slice(0, 300)}`);
  }
  if (!bytes || !bytes.length) throw new Error('Typst 未产出 PDF');
  return { bytes };
}
