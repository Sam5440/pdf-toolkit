// Pandoc WASM 引擎包装（懒加载 + 加载进度 + 单例缓存）。
// - core：../vendor-pandoc-core.js 的 createPandocInstance（GPL-2.0+，pandoc-wasm@1.1.0 副本）
// - wasm：public/engines/pandoc/pandoc.wasm（pandoc 3.10，scripts/fetch-engines.mjs 重建）
// 实例化即初始化 Haskell RTS（数秒），之后 convert 可反复调用。
import { createPandocInstance } from '../vendor-pandoc-core.js';

let instancePromise = null;

const WASM_URL_ERROR =
  'pandoc 引擎文件缺失：请先运行 node scripts/fetch-engines.mjs 生成 public/engines/pandoc/pandoc.wasm';

async function fetchWithProgress(url, onProgress, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) throw new Error(WASM_URL_ERROR);
      if (!res.ok) throw new Error(`pandoc.wasm 加载失败：HTTP ${res.status}`);
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
      if (attempt >= retries || (err instanceof TypeError && attempt >= 1)) {
        // 保留业务错误（404 提示等）直抛；网络类错误重试后仍失败才抛出
        if (!(err instanceof TypeError)) throw err;
        throw new Error(`pandoc.wasm 下载失败（已重试）：${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

const mb = (n) => `${(n / 1048576).toFixed(0)}MB`;

/** 获取（并缓存）pandoc 实例。onStage(stageText) 汇报阶段。 */
export async function getPandoc({ onStage } = {}) {
  if (!instancePromise) {
    instancePromise = (async () => {
      const url = new URL('engines/pandoc/pandoc.wasm', document.baseURI).href;
      const bytes = await fetchWithProgress(url, (loaded, total) => {
        onStage?.(`下载 pandoc.wasm ${mb(loaded)}${total ? ` / ${mb(total)}` : ''}（首次加载，之后走浏览器缓存）…`);
      });
      onStage?.('初始化 pandoc 引擎（首次需数秒）…');
      return createPandocInstance(bytes);
    })().catch((err) => { instancePromise = null; throw err; });
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
