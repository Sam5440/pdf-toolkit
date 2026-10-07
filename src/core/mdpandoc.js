// Pandoc WASM 引擎包装（懒加载 + 加载进度 + 单例缓存）。
// - core：../vendor-pandoc-core.js 的 createPandocInstance（GPL-2.0+，pandoc-wasm@1.1.0 副本）
// - wasm：public/engines/pandoc/pandoc.wasm（pandoc 3.10，scripts/fetch-engines.mjs 重建）
// wasm 经 asset-cache 持久化到 Cache Storage：下载一次，之后零网络（含离线）。
import { createPandocInstance } from '../vendor-pandoc-core.js';
import { setEngineStatus } from './wasm-registry.js';
import { fetchEngineAsset } from './asset-cache.js';
import { log } from './logs.js';

let instancePromise = null;

const WASM_URL_ERROR =
  'pandoc 引擎文件未找到：若刚重建/重启过站点请刷新页面后重试；若持续出现，请运行 node scripts/fetch-engines.mjs 生成 public/engines/pandoc/pandoc.wasm';

const mb = (n) => `${(n / 1048576).toFixed(0)}MB`;

/** 获取（并缓存）pandoc 实例。onStage(stageText) 汇报阶段。 */
export async function getPandoc({ onStage } = {}) {
  if (!instancePromise) {
    setEngineStatus('pandoc', 'loading', '准备下载…');
    instancePromise = (async () => {
      const url = new URL('engines/pandoc/pandoc.wasm', document.baseURI).href;
      const bytes = await fetchEngineAsset(url, {
        label: 'pandoc.wasm',
        retries: 2,
        missingError: WASM_URL_ERROR,
        onProgress: (loaded, total) => {
          const stage = `下载 pandoc.wasm ${mb(loaded)}${total ? ` / ${mb(total)}` : ''}（首次加载，之后持久化到本机）…`;
          onStage?.(stage);
          setEngineStatus('pandoc', 'loading', stage, { progress: total ? { loaded, total } : null });
        },
      });
      log('pandoc', `pandoc.wasm 已就绪（${mb(bytes.byteLength)}）`);
      const initStage = '初始化 pandoc 引擎（首次需数秒）…';
      onStage?.(initStage);
      setEngineStatus('pandoc', 'loading', initStage);
      return createPandocInstance(bytes);
    })()
      .then((p) => { setEngineStatus('pandoc', 'ready', 'pandoc 3.10'); return p; })
      .catch((err) => { setEngineStatus('pandoc', 'error', err?.message || String(err)); instancePromise = null; throw err; });
  }
  return instancePromise;
}

/**
 * Markdown → docx（pandoc 高保真 writer：脚注/任务列表/表格样式/TOC 等）。
 * 返回 { bytes: Uint8Array }。
 */
export async function pandocToDocx(markdown, { onStage } = {}) {
  const pandoc = await getPandoc({ onStage });
  onStage?.('pandoc 转换中…');
  const { files } = await pandoc.convert(
    { from: 'markdown+east_asian_line_breaks', to: 'docx', 'output-file': 'out.docx' },
    String(markdown ?? ''),
    {},
  );
  const blob = files?.['out.docx'];
  if (!blob) throw new Error('pandoc 未产出 docx 文件');
  return { bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/**
 * Markdown → Typst 源码（typst writer，供 mdtypst.js 二段编译）。
 * 返回 { source: string }。
 */
export async function pandocToTypst(markdown, { onStage } = {}) {
  const pandoc = await getPandoc({ onStage });
  onStage?.('pandoc：Markdown → Typst 源…');
  const { stdout } = await pandoc.convert(
    { from: 'markdown+east_asian_line_breaks', to: 'typst' },
    String(markdown ?? ''),
    {},
  );
  const src = typeof stdout === 'string' ? stdout : new TextDecoder().decode(stdout || new Uint8Array());
  if (!src.trim()) throw new Error('pandoc 未产出 Typst 源码');
  return { source: src };
}
