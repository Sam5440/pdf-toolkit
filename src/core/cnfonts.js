// 内置中文字体回退（渲染用）：public/fonts/cn/ 下 4 个开源字体子集（GB2312+，
// 由 scripts/build_cn_fonts.py 生成），按真实字体名注册 FontFace 别名，覆盖 10 种
// 最常见中文字体：
//   宋体系（noto-serif）：宋体 SimSun / 新宋体 NSimSun / 华文宋体 STSong / 华文中宋 STZhongsong
//   黑体系（noto-sans）：黑体 SimHei / 微软雅黑 Microsoft YaHei / 华文黑体 STHeiti / 华文细黑 STXihei / 等线 DengXian
//   楷体系（wenkai）　：楷体 KaiTi / 华文楷体 STKaiti（霞鹜文楷 GB）
//   仿宋系（zhuque）　：仿宋 FangSong / 华文仿宋 STFangsong（朱雀仿宋）
// 消费方：
//   - engine-worker（pdf.js 渲染）：未嵌入字体的 canvas 字体串以原始字体名开头，
//     注册同名 FontFace 即可命中（GBK 编码的旧式字体名在 pdf.js 里是 latin1 乱码串，
//     也按原样注册，见 GBK_MOJIBAKE）。
//   - office.js（Word/PPT 栅格化）：SVG-as-image 不使用 document 网页字体，
//     需把 @font-face data-URI 注入 SVG 内部（getCNFontFaceRules）。
// 注意：本模块顶层不得触碰 document/self.fonts（vitest node 环境经 import 链会炸）。
import { toolkitError } from './errors.js';

export const CN_FONTS_BASE = `${import.meta.env.BASE_URL}fonts/cn/`;

// pdf.js 对 GBK 编码的字体名（宋体/黑体/楷体/仿宋）按 latin1 逐字节呈现为
// U+0080-U+00FF 乱码串；canvas 字体串的第一族名就是这个串，必须按原样注册别名。
const GBK_MOJIBAKE = {
  宋体: '\u00CB\u00CE\u00CC\u00E5',
  新宋体: '\u00D0\u00C2\u00CB\u00CE\u00CC\u00E5',
  黑体: '\u00BA\u00DA\u00CC\u00E5',
  楷体: '\u00BF\u00AC\u00CC\u00E5',
  仿宋: '\u00B7\u00C2\u00CB\u00CE',
};
const MOJIBAKE_SET = new Set(Object.values(GBK_MOJIBAKE));

export const CN_FONT_FILES = [
  {
    id: 'noto-serif',
    file: 'noto-serif.woff2',
    internal: 'PTK Serif SC',
    source: 'Noto Serif CJK SC (OFL 1.1)',
    aliases: ['SimSun', 'NSimSun', '宋体', '新宋体', GBK_MOJIBAKE.宋体, GBK_MOJIBAKE.新宋体, 'STSong', 'STZhongsong', '华文宋体', '华文中宋'],
  },
  {
    id: 'noto-sans',
    file: 'noto-sans.woff2',
    internal: 'PTK Sans SC',
    source: 'Noto Sans CJK SC (OFL 1.1)',
    aliases: ['SimHei', '黑体', GBK_MOJIBAKE.黑体, 'Microsoft YaHei', 'MicrosoftYaHei', '微软雅黑', 'STHeiti', '华文黑体', 'STXihei', '华文细黑', 'DengXian', '等线'],
  },
  {
    id: 'wenkai',
    file: 'wenkai.woff2',
    internal: 'PTK Kai GB',
    source: 'LXGW WenKai GB (OFL 1.1)',
    aliases: ['KaiTi', '楷体', GBK_MOJIBAKE.楷体, 'KaiTi_GB2312', '楷体_GB2312', 'STKaiti', '华文楷体'],
  },
  {
    id: 'zhuque',
    file: 'zhuque.woff2',
    internal: 'PTK Fangsong',
    source: 'Zhuque Fangsong (OFL 1.1)',
    aliases: ['FangSong', '仿宋', GBK_MOJIBAKE.仿宋, 'FangSong_GB2312', '仿宋_GB2312', 'STFangsong', '华文仿宋'],
  },
];

/** 别名（小写化）→ 字体文件 id */
const ALIAS_INDEX = new Map();
for (const f of CN_FONT_FILES) {
  for (const a of f.aliases) ALIAS_INDEX.set(a.toLowerCase(), f.id);
}

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', '-apple-system',
]);

const cache = new Map(); // id → ArrayBuffer

export function cnFontFileUrl(id) {
  const def = CN_FONT_FILES.find((f) => f.id === id);
  if (!def) throw toolkitError('ERR_FONT', `未知中文字体 ${id}`);
  return CN_FONTS_BASE + def.file;
}

export async function getCNFontBytes(id) {
  if (cache.has(id)) return cache.get(id);
  const url = cnFontFileUrl(id);
  let bytes;
  try {
    const c = await caches.open('pdftoolkit-fonts-v1');
    const hit = await c.match(url);
    if (hit) bytes = await hit.arrayBuffer();
    else {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = await resp.arrayBuffer();
      await c.put(url, new Response(bytes.slice(0), { headers: { 'Content-Type': 'font/woff2' } }));
    }
  } catch (e) {
    throw toolkitError('ERR_FONT', `中文字体获取失败（${e.message}）。离线部署请确保 public/fonts/cn 随站点提供`);
  }
  cache.set(id, bytes);
  return bytes;
}

/**
 * 把解析出的 font-family 名单映射到需要的中文字体文件 id 集合。
 * 未命中任何别名的 CJK 文本由调用方决定是否追加默认黑体兜底。
 */
export function cnFontIdsForNames(names) {
  const out = new Set();
  for (const n of names || []) {
    const id = ALIAS_INDEX.get(String(n).toLowerCase());
    if (id) out.add(id);
  }
  return out;
}

/** 从 style 文本（font-family: ...）解析字体族名单：去引号、去通用关键字 */
export function parseFontFamilyList(text) {
  const out = [];
  if (!text) return out;
  const m = /font-family\s*:\s*([^;}]+)/i.exec(String(text));
  if (!m) return out;
  for (const part of m[1].split(',')) {
    const name = part.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!name || GENERIC_FAMILIES.has(name.toLowerCase()) || name.startsWith('+')) continue;
    out.push(name);
  }
  return out;
}

/** 本上下文的 FontFaceSet（worker: self.fonts；主线程: document.fonts）；无则 null */
function fontSet() {
  try {
    if (typeof document !== 'undefined' && document.fonts) return document.fonts;
  } catch { /* ignore */ }
  try {
    if (typeof self !== 'undefined' && self.fonts) return self.fonts;
  } catch { /* ignore */ }
  return null;
}

let cnFacesReady = null;

/**
 * 把全部中文字体别名注册为本上下文 FontFace（幂等）。
 * 每个别名一个 FontFace（同源数据共享），任一失败不影响其余。
 * @returns {Promise<boolean>} 至少注册了一个别名
 */
export function ensureCNFontFaces() {
  if (!cnFacesReady) {
    cnFacesReady = (async () => {
      const set = fontSet();
      if (!set || typeof FontFace === 'undefined') return false;
      let ok = 0;
      for (const f of CN_FONT_FILES) {
        let bytes;
        try {
          bytes = await getCNFontBytes(f.id);
        } catch {
          continue;
        }
        for (const alias of f.aliases) {
          try {
            const face = new FontFace(alias, bytes);
            await face.load();
            set.add(face);
            ok++;
          } catch { /* 环境不支持（如旧 Safari worker）则跳过该别名 */ }
        }
      }
      return ok > 0;
    })().catch(() => false);
  }
  return cnFacesReady;
}

const ruleCache = new Map(); // fileId → Promise<css 规则文本>
const dataUrlCache = new Map(); // fileId → Promise<dataURL>

async function fontDataUrl(id) {
  if (!dataUrlCache.has(id)) {
    dataUrlCache.set(id, (async () => {
      const bytes = new Uint8Array(await getCNFontBytes(id));
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      return `data:font/woff2;base64,${btoa(bin)}`;
    })().catch((e) => { dataUrlCache.delete(id); throw e; }));
  }
  return dataUrlCache.get(id);
}

/**
 * 生成 @font-face 规则文本（SVG foreignObject 内嵌用——SVG-as-image 不读
 * document 字体，必须把字体以 data-URI 形式写进 SVG 自己的 <style>）。
 * @param {string[]} names 已解析的 font-family 名单
 * @returns {Promise<string>} css 文本（无命中返回 ''）
 */
export async function getCNFontFaceRules(names) {
  const ids = cnFontIdsForNames(names);
  if (!ids.size) return '';
  const rules = await Promise.all([...ids].map(async (id) => {
    if (!ruleCache.has(id)) {
      ruleCache.set(id, (async () => {
        const def = CN_FONT_FILES.find((f) => f.id === id);
        const url = await fontDataUrl(id);
        const faces = def.aliases.filter((a) => !MOJIBAKE_SET.has(a));
        return faces.map((a) => `@font-face{font-family:"${a}";src:url("${url}") format("woff2");}`).join('');
      })().catch((e) => { ruleCache.delete(id); throw e; }));
    }
    return ruleCache.get(id);
  }));
  return rules.join('');
}
