// 应用设置（localStorage；绝不存储密码）
const KEY = 'pdftoolkit.settings.v1';

const DEFAULTS = {
  theme: 'light',                 // light | dark | auto
  accent: 'neutral',              // neutral | blue | violet | green | amber | red（强调色）
  dopamine: '',                   // '' | candy|citrus|lime|sky|grape|coral|teal|mango（右下角浮钮的随机多巴胺配色，双击浮钮恢复）
  viewMode: 'cards',              // cards（工具卡片网格，默认）| list（列表视图，首页/更多页/首页内联展开共用）
  radius: 'default',              // none | sm | default | lg | xl（圆角档位）
  motion: true,                   // 界面动画与过渡
  iconSet: 'svg',                 // svg（手绘线描，默认）| color（多彩手绘）| emoji（原版 emoji）
  maxUploadMB: 500,               // 单文件上限
  warnUploadMB: 100,              // 提示阈值
  maxRenderDpi: 600,              // 渲染 DPI 上限
  maxOcrDpi: 300,
  maxRenderPixels: 4096 * 4096,   // 单页渲染像素上限
  ocrDpi: 200,
  historyQuotaMB: 500,            // 历史输出保留配额
  trayQuotaMB: 1024,              // 暂存区持久化配额（超出自动逐出最旧条目）
  workerCount: 0,                 // 0=自动
  compareDpi: 110,
  previewDebounceMs: 350,
  namingTemplate: '{name}-{op}-{params}-{time}', // 产物命名模板（{name}{op}{params}{time}{i}）
  recentEnabled: true,            // 首页第一行「最近使用」+ 使用记录
  taskAutoRecord: true,           // 每个生成任务自动存完整参数历史（历史页可一键复原）
  remoteFontUrls: [],             // 远程外挂字体 URL（每次启动自动下载并持久化到本机）
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
