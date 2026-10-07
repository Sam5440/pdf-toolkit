// 产物默认命名规则：原名 + 操作 + 参数（超长按 10 字符截断）+ 时间。
// 模板可在设置中自定义，可用令牌：{name} {op} {params} {time} {i}。
// 引擎 run() 的结果在镜像暂存区前统一改名（engine.js finish）；
// 不经过引擎的客户端产物由各工具用 buildOutputName 命名。
import { getSettings } from './settings.js';
import { sanitizeFilename, baseName, extOf } from './format.js';

export const DEFAULT_NAMING_TEMPLATE = '{name}-{op}-{params}-{time}';
export const NAMING_PARAM_MAX = 10;

/** 引擎 op → 中文操作名（未命中回退 op 末段） */
const OP_LABELS = {
  'compare.run': '对比',
  'compress.run': '压缩',
  'crypto.decrypt': '解密',
  'crypto.encrypt': '加密',
  'doc.unlock': '解锁',
  'flatten.run': '扁平化',
  'form.create': '表单创建',
  'form.fill': '表单填写',
  'images.extract': '提取图片',
  'images.toPdf': '图片转PDF',
  'meta.edit': '元数据',
  'meta.strip': '清元数据',
  'ocr.run': 'OCR',
  'outlines.add': '书签',
  'overlay.apply': '叠加',
  'page.addContent': '编辑',
  'pages.crop': '裁剪',
  'pages.extract': '提取页',
  'pages.halve': '切半',
  'pages.merge': '合并',
  'pages.nup': '拼版',
  'pages.organize': '整理',
  'pages.pagenumbers': '页码',
  'pages.remove': '删页',
  'pages.resize': '调整页面',
  'pages.rotate': '旋转',
  'pages.split': '拆分',
  'pdf.exportOffice': '转Office',
  'pdf.toImages': '转图片',
  'pdf.toSvg': '转SVG',
  'pdf.toTiff': '转TIFF',
  'raster.run': '栅格化',
  'redact.apply': '涂黑',
  'repair.run': '修复',
  'text.extract': '提取文字',
  'text.toPdf': '文字转PDF',
  'viewer.prefs': '查看器偏好',
  'wm.apply': '水印',
  'wm.preview': '水印预览',
};

/** 参数串中跳过的键：文档句柄/源名 / 大字节负载 / 整块结构 / 派生命名（可读性与体积） */
const SKIP_ARG_RE = /^(docIds?|baseDocId|overlayDocId|baseName|name|bytes|imageBytes|fontPacks|customFonts|limits|vars|spec|layers|edits|items|objects|blocks|fields|bookmarks|imageMime)$/i;
const SECRET_RE = /pass|secret|token/i;

export function opLabel(op) {
  return OP_LABELS[String(op || '')] || String(op || '').split('.').pop() || '处理';
}

/** 参数令牌：最多取 3 个原始类型参数键，整体按 NAMING_PARAM_MAX 截断 */
export function paramsToken(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (SKIP_ARG_RE.test(k) || SECRET_RE.test(k) || v == null) continue;
    let s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else continue; // 数组/对象不入名（体积大且不可读）
    s = sanitizeFilename(s).replace(/[\s,，]+/g, '');
    if (!s) continue;
    parts.push(`${k}=${s}`);
    if (parts.length >= 3) break;
  }
  const joined = parts.join(',');
  return joined.length > NAMING_PARAM_MAX ? joined.slice(0, NAMING_PARAM_MAX).replace(/[,，]+$/, '') : joined;
}

/** 时间令牌：YYYYMMDD-HHmm（本地时区） */
export function timeToken(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 当前命名模板（设置自定义；空/损坏回退默认） */
export function getNamingTemplate() {
  try {
    const t = getSettings().namingTemplate;
    return typeof t === 'string' && t.trim() ? t.trim() : DEFAULT_NAMING_TEMPLATE;
  } catch {
    return DEFAULT_NAMING_TEMPLATE;
  }
}

/**
 * 按模板生成单个产物名。空段自动折叠：连续分隔符收为一个，首尾分隔符去除。
 * @param {{name?:string, op?:string, params?:string, time?:string, template?:string, index?:string}} p
 */
export function buildOutputName(p = {}) {
  const tpl = p.template || getNamingTemplate();
  let out = String(tpl)
    .replaceAll('{name}', baseName(p.name ?? '') || '文档')
    .replaceAll('{op}', p.op || '处理')
    .replaceAll('{params}', p.params || '')
    .replaceAll('{time}', p.time ?? timeToken()) // 客户端直接调用时缺省为当前时间
    .replaceAll('{i}', p.index ?? '');
  out = out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').trim();
  return sanitizeFilename(out);
}

/** 从引擎产物名提取逐项区分段（如 p001 / 第1-3页 / 图02）：去扩展名后剥掉来源 base 前缀 */
export function artifactDiscriminator(artName, base) {
  if (!base) return '';
  const stem = baseName(artName ?? '');
  if (!stem.startsWith(base)) return '';
  const rest = stem.slice(base.length).replace(/^[_\-\s]+/, '');
  return rest ? sanitizeFilename(rest) : '';
}

function uniqueName(name, ext, used) {
  const n = used.get(name) || 0;
  used.set(name, n + 1);
  if (n === 0) return ext ? `${name}.${ext}` : name;
  return ext ? `${name}(${n + 1}).${ext}` : `${name}(${n + 1})`;
}

function sourceBaseName(docs, args) {
  let id = args?.docId;
  if (!id && Array.isArray(args?.docIds) && args.docIds.length) id = args.docIds[0];
  if (!id && Array.isArray(args?.items) && args.items.length) id = args.items[0]?.docId;
  if (!id) id = args?.baseDocId;
  const doc = id && docs?.get ? docs.get(id) : null;
  return doc?.name ? baseName(doc.name) : '';
}

/**
 * 引擎产物统一按命名规则改名（原位修改 artifacts）。
 * 多产物时追加逐项区分段（worker 名中的页码/序号；提取不到则用 01、02…）保证唯一。
 * @param {Array<{name:string}>|undefined} artifacts
 * @param {{op?:string, args?:object, docs?:Map, template?:string, now?:number}} ctx
 */
export function applyNamingToArtifacts(artifacts, ctx = {}) {
  if (!Array.isArray(artifacts) || !artifacts.length) return artifacts;
  const { op, args = {}, docs = null } = ctx;
  const base = sourceBaseName(docs, args);
  const params = paramsToken(args);
  const time = timeToken(ctx.now ? new Date(ctx.now) : undefined);
  const multi = artifacts.length > 1;
  const used = new Map();
  artifacts.forEach((a, i) => {
    if (!a || a.name == null) return;
    const ext = extOf(a.name);
    let nm = buildOutputName({
      name: base || a.name,
      op: opLabel(op),
      params,
      time,
      template: ctx.template,
    });
    if (multi) {
      const disc = base ? artifactDiscriminator(a.name, base) : '';
      nm = `${nm}-${disc || String(i + 1).padStart(2, '0')}`;
    }
    a.name = uniqueName(nm, ext, used);
  });
  return artifacts;
}
