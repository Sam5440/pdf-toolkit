// Pandoc WASM 引擎包装（懒加载 + 加载进度 + 单例缓存）。
// - core：../vendor-pandoc-core.js 的 createPandocInstance（GPL-2.0+，pandoc-wasm@1.1.0 副本）
// - wasm：public/engines/pandoc/pandoc.wasm（pandoc 3.10，scripts/fetch-engines.mjs 重建）
// 实例化即初始化 Haskell RTS（数秒），之后 convert 可反复调用。
import { createPandocInstance } from '../vendor-pandoc-core.js';
import { setEngineStatus } from './wasm-registry.js';

let instancePromise = null;

const WASM_URL_ERROR =
  'pandoc 引擎文件未找到：若刚重建/重启过站点请刷新页面后重试；若持续出现，请运行 node scripts/fetch-engines.mjs 生成 public/engines/pandoc/pandoc.wasm';

async function fetchWithProgress(url, onProgress, retries = 2) {
  // 404 也重试：vite build 会先清空 dist 再拷贝 public，重建的数秒窗口内静态文件短暂 404，
  // 用户此时操作会被误报"文件缺失"；重试耗尽仍 404 才提示 fetch-engines。
  // 网络类 TypeError（含下载中途断流）重试 1 次整体重下；其余业务错误直抛。
  for (let attempt = 0; ; attempt++) {
    let notFound = false;
    try {
      const res = await fetch(url);
      if (res.status === 404) { notFound = true; throw new TypeError('404'); }
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
      if (!(notFound || err instanceof TypeError)) throw err;
      if (attempt >= (notFound ? retries : 1)) {
        if (notFound) throw new Error(WASM_URL_ERROR);
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
    setEngineStatus('pandoc', 'loading', '准备下载…');
    instancePromise = (async () => {
      const url = new URL('engines/pandoc/pandoc.wasm', document.baseURI).href;
      const bytes = await fetchWithProgress(url, (loaded, total) => {
        const stage = `下载 pandoc.wasm ${mb(loaded)}${total ? ` / ${mb(total)}` : ''}（首次加载，之后走浏览器缓存）…`;
        onStage?.(stage);
        setEngineStatus('pandoc', 'loading', stage);
      });
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
