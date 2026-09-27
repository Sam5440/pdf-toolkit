// 应用设置（localStorage；绝不存储密码）
const KEY = 'pdftoolkit.settings.v1';

const DEFAULTS = {
  theme: 'light',                 // light | dark | auto
  maxUploadMB: 500,               // 单文件上限
  warnUploadMB: 100,              // 提示阈值
  maxRenderDpi: 600,              // 渲染 DPI 上限
  maxOcrDpi: 300,
  maxRenderPixels: 4096 * 4096,   // 单页渲染像素上限
  ocrDpi: 200,
  historyQuotaMB: 500,            // 历史输出保留配额
  workerCount: 0,                 // 0=自动
  compareDpi: 110,
  previewDebounceMs: 350,
};

let cache = null;
const listeners = new Set();

export function getSettings() {
  if (cache) return { ...DEFAULTS, ...cache };
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch { cache = {}; }
  return { ...DEFAULTS, ...cache };
}

export function setSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  cache = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 忽略配额错误 */ }
  listeners.forEach((fn) => { try { fn(key, value); } catch { /* noop */ } });
}

export function onSettingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
