// Typst 排版引擎（WASM）：Markdown → PDF（杂志级排版，浏览器内编译，文件不出浏览器）。
// 链路：pandoc（md → typst 源）+ typst.ts 0.7.0（typst 0.14.2 编译器 wasm → PDF bytes）。
// - wasm：public/engines/typst/typst_ts_web_compiler_bg.wasm（28.3MB，fetch-engines 重建）
// - 字体：public/fonts/text/NotoSansSC-*.ttf（GB2312+常用符号子集，2.2MB/字重）
//         public/fonts/typst/NewCMMath-*.otf（数学）、DejaVuSansMono*.ttf（等宽）
// 禁用 typst.ts 默认远程字体资产（离线）；Java/Kotlin 未涉及。COOP/COEP 非必需（单线程）。
import { $typst } from '@myriaddreamin/typst.ts';
import { loadFonts, disableDefaultFontAssets } from '@myriaddreamin/typst.ts/options.init';
import { pandocToTypst, getPandoc } from './mdpandoc.js';
import { setEngineStatus } from './wasm-registry.js';
import { fetchEngineAsset } from './asset-cache.js';
import { listUserFonts, getUserFontBytes } from './userfonts.js';

// 资产基址惰性求值（模块可能被 node 环境测试链路引入，不能在顶层触碰 document）
const fontUrl = (name) => new URL(`fonts/${name}`, document.baseURI).href;
const engineUrl = (name) => new URL(`engines/typst/${name}`, document.baseURI).href;

let initDone = false;
let initPromise = null;
let initFontSig = ''; // 初始化时已注入的外挂字体签名（变化后需重新初始化才能进字体池）

const PAPERS = {
  a4: '"a4"', letter: '"us-letter"', a5: '"a5"', a3: '"a3"', legal: '"us-legal"',
};

/** 外挂字体 → [{id, bytes}]（Typst loadFonts 原生支持 Uint8Array） */
async function loadUserFontData() {
  try {
    const metas = await listUserFonts();
    const out = [];
    for (const m of metas) {
      try {
        out.push({ id: m.id, bytes: new Uint8Array(await getUserFontBytes(m.id)) });
      } catch { /* 单个字体读取失败不阻塞编译 */ }
    }
    return out;
  } catch {
    return [];
  }
}

const fontSigOf = (fonts) => fonts.map((f) => `${f.id}:${f.bytes.byteLength}`).join('|');

async function ensureTypst(onStage) {
  if (initDone) return;
  if (!initPromise) {
    setEngineStatus('typst', 'loading', '准备下载…');
    const userFonts = await loadUserFontData();
    initFontSig = fontSigOf(userFonts);
    initPromise = (async () => {
      // wasm 经 asset-cache 持久化到 Cache Storage：下载一次，之后零网络（含离线）。
      // 404 同样重试——vite build 清空 dist 的数秒窗口内会短暂 404，别误报"文件缺失"。
      const wasmBytes = await fetchEngineAsset(engineUrl('typst_ts_web_compiler_bg.wasm'), {
        label: 'Typst 引擎',
        retries: 2,
        missingError: 'Typst 引擎文件未找到：若刚重建/重启过站点请刷新页面后重试；若持续出现，请运行 node scripts/fetch-engines.mjs',
        onProgress: (loaded, total) => {
          const stage = `下载 Typst 引擎 ${(loaded / 1048576).toFixed(0)}MB / ${(total / 1048576).toFixed(0)}MB（首次加载，之后持久化到本机）…`;
          onStage?.(stage);
          setEngineStatus('typst', 'loading', stage, { progress: total ? { loaded, total } : null });
        },
      });
      const initStage = '初始化 Typst 编译器…';
      onStage?.(initStage);
      setEngineStatus('typst', 'loading', initStage);
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
            // 外挂字体（设置面板上传/远程订阅）：字节直接注入字体池
            ...userFonts.map((f) => f.bytes),
          ]),
        ],
      });
      // 触发一次极小编译完成全部惰性初始化（wasm + 字体）
      const ok = await $typst.pdf({ mainContent: '#set page(width: 10pt, height: 10pt, margin: 0pt)\nX' });
      if (!ok || !ok.length) throw new Error('Typst 引擎自检失败');
    })()
      .then(() => { setEngineStatus('typst', 'ready', 'typst 0.14.2'); initDone = true; })
      .catch((err) => { setEngineStatus('typst', 'error', err?.message || String(err)); initPromise = null; throw err; });
  }
  return initPromise;
}

/** 外挂字体变化后重新初始化 Typst（重建字体池；wasm 走持久缓存，代价为数秒初始化） */
async function ensureTypstFresh(onStage) {
  if (!initDone) return ensureTypst(onStage);
  const userFonts = await loadUserFontData();
  if (fontSigOf(userFonts) === initFontSig) return;
  initDone = false;
  initPromise = null;
  await ensureTypst(onStage);
}

/** pandoc 版纸张/字号 → typst 版式头 */
function preamble({ paper = 'a4', fontSize = 11, fontFamily = 'Noto Sans SC' }) {
  const p = PAPERS[paper] ?? PAPERS.a4;
  const pt = Number(fontSize) || 11;
  // 页边距对齐内置引擎 48pt ≈ 1.69cm；行距 1.6；中英文混排；正文族可用外挂字体覆盖
  return [
    '#set page(paper: ' + p + ', margin: (x: 1.69cm, y: 1.69cm), numbering: none)',
    '#set text(font: ' + JSON.stringify(fontFamily || 'Noto Sans SC') + ', size: ' + pt + 'pt, lang: "zh", region: "cn", top-edge: "cap-height", bottom-edge: "baseline")',
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
    // pandoc 非模板（fragment）输出会调用 #horizontalrule（md 的 --- 分隔线），
    // 定义取自 pandoc 官方模板 default.typst（3.10 输出小写名）
    '#let horizontalrule = line(start: (25%, 0%), end: (75%, 0%))',
  ].join('\n');
}

/**
 * Markdown → PDF bytes（Typst 排版）。
 * onStage(stageText) / onPct(0..1) 汇报进度。返回 { bytes, warnings? }。
 */
export async function markdownToPdfTypst(markdown, { paper, fontSize, title, fontFamily, onStage } = {}) {
  onStage?.('准备 pandoc 引擎…');
  // 提前确保 pandoc 已就绪（复用同一实例）
  await getPandoc({ onStage });
  const { source } = await pandocToTypst(markdown, { onStage });
  onStage?.('准备 Typst 引擎（首次约 28MB）…');
  await ensureTypstFresh(onStage);
  onStage?.('Typst 编译 PDF…');
  const head = preamble({ paper, fontSize, fontFamily });
  const doc = title ? `#set document(title: ${JSON.stringify(title)})\n${head}\n${source}` : `${head}\n${source}`;
  let bytes;
  try {
    bytes = await $typst.pdf({ mainContent: doc });
  } catch (err) {
    const msg = String(err?.message || err);
    // SourceDiagnostic 转储里抽可读的 message 字段，别给用户看结构体
    const readable = [...msg.matchAll(/message:\s*"([^"]*)"/g)].map((m) => m[1]).join('；');
    throw new Error(`Typst 编译失败：${readable || msg.slice(0, 300)}`);
  }
  if (!bytes || !bytes.length) throw new Error('Typst 未产出 PDF');
  return { bytes };
}
