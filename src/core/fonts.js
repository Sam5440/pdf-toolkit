// 字体加载：CJK 字体按需获取 + Cache API 缓存。子集化在 worker 内由 fontkit 完成。
import { toolkitError } from './errors.js';

export const FONTS = [
  {
    id: 'noto-sc',
    name: '思源黑体（中英文）',
    url: `${import.meta.env.BASE_URL}fonts/NotoSansSC-Regular.ttf`,
    boldUrl: `${import.meta.env.BASE_URL}fonts/NotoSansSC-Bold.ttf`,
    cjk: true,
    optional: true, // 下载失败不阻塞应用，仅禁用中文字体水印
  },
];

const cache = new Map(); // id+bold → ArrayBuffer

export function isCJKText(s) {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(String(s || ''));
}

/** 已内置的标准字体（无需下载） */
export const BUILTIN_FONTS = [
  { id: 'helvetica', name: 'Helvetica（拉丁）', cjk: false },
  { id: 'times', name: 'Times（拉丁）', cjk: false },
  { id: 'courier', name: 'Courier（拉丁）', cjk: false },
];

export async function getFontBytes(fontId, { bold = false } = {}) {
  const key = `${fontId}:${bold ? 'b' : 'r'}`;
  if (cache.has(key)) return cache.get(key);
  const def = FONTS.find((f) => f.id === fontId);
  if (!def) throw toolkitError('ERR_FONT', `未知字体 ${fontId}`);
  const url = bold && def.boldUrl ? def.boldUrl : def.url;
  let bytes;
  try {
    const c = await caches.open('pdftoolkit-fonts-v1');
    const hit = await c.match(url);
    if (hit) { bytes = await hit.arrayBuffer(); }
    else {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = await resp.arrayBuffer();
      await c.put(url, new Response(bytes.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } }));
    }
  } catch (e) {
    throw toolkitError('ERR_FONT', `无法加载字体文件（${e.message}）。离线部署时请确保 public/fonts 内字体已随站点提供`);
  }
  cache.set(key, bytes);
  return bytes;
}

/** 探测字体资产是否可用（应用启动时调用一次） */
export async function probeFonts() {
  const out = {};
  for (const f of FONTS) {
    try {
      const resp = await fetch(f.url, { method: 'HEAD' });
      out[f.id] = resp.ok;
    } catch { out[f.id] = false; }
  }
  return out;
}

let cjkFontFaceReady = null;

/**
 * 把 CJK 字体注册为 document FontFace（供 Canvas 栅格化水印文字用）。
 * 成功返回字体族名；失败（离线且无缓存）返回系统字体栈——Canvas 仍能渲染。
 * 背景：pdf-lib subset:true 对大型 CJK 字体产出损坏字形（社区已知缺陷），
 * 全量嵌入又使产物 +6MB，故 CJK 水印走 Canvas→PNG 栅格路径。
 */
export async function ensureCJKFontFace() {
  if (!cjkFontFaceReady) {
    cjkFontFaceReady = (async () => {
      try {
        const bytes = await getFontBytes('noto-sc');
        const face = new FontFace('pdftoolkit-cjk', bytes);
        await face.load();
        document.fonts.add(face);
        return true;
      } catch {
        return false;
      }
    })();
  }
  const ok = await cjkFontFaceReady;
  return ok ? "'pdftoolkit-cjk', " : '';
}

export const CJK_FONT_STACK = `'pdftoolkit-cjk', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`;
