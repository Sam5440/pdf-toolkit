// 收藏管理：收藏仅决定工具是否在首页显示（localStorage 持久化，try/catch 兼容隐私模式）
// 默认收藏 = 全部「非更多」核心工具；「更多」工具默认不收藏。
import { TOOLS, GROUPS } from '../tools/registry.js';

const KEY = 'pdftoolkit.favorites.v1';
let cache = null;

export function isMoreGroup(groupId) {
  const g = GROUPS.find((x) => x.id === groupId);
  return !!(g && g.hiddenOnHome);
}

export function defaultFavoriteIds() {
  // 核心工具 + 带 defaultFav 标记的「更多」工具（如 Markdown 转 PDF）
  return TOOLS.filter((t) => !isMoreGroup(t.group) || t.defaultFav).map((t) => t.id);
}

// 一次性迁移：给已有收藏存档的老用户补上新 defaultFav 工具（保留其余手工调整）
const MIGRATIONS = [
  { key: 'pdftoolkit.favorites.mig-md2pdf', tool: 'md2pdf' },
  { key: 'pdftoolkit.favorites.mig-pdf2pptimg', tool: 'pdf2pptimg' },
  { key: 'pdftoolkit.favorites.mig-crop', tool: 'crop' },
  { key: 'pdftoolkit.favorites.mig-util1', tool: 'qrcode-scan' },
  { key: 'pdftoolkit.favorites.mig-util2', tool: 'hash-calc' },
  { key: 'pdftoolkit.favorites.mig-util3', tool: 'crypt' },
  { key: 'pdftoolkit.favorites.mig-util4', tool: 'imgocr' },
  { key: 'pdftoolkit.favorites.mig-util5', tool: 'filebed' },
];

function loadStoredIds() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const ids = JSON.parse(raw);
    if (!Array.isArray(ids)) return null;
    let changed = false;
    for (const m of MIGRATIONS) {
      if (localStorage.getItem(m.key)) continue;
      if (!ids.includes(m.tool)) { ids.push(m.tool); changed = true; }
      localStorage.setItem(m.key, '1');
    }
    if (changed) localStorage.setItem(KEY, JSON.stringify(ids));
    return ids;
  } catch { /* 隐私模式/损坏数据 → 默认 */ }
  return null;
}

export function getFavorites() {
  if (cache) return cache;
  let ids = loadStoredIds();
  if (!ids) ids = defaultFavoriteIds();
  const valid = new Set(TOOLS.map((t) => t.id));
  cache = new Set(ids.filter((id) => valid.has(id)));
  return cache;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify([...getFavorites()])); } catch { /* ignore */ }
}

export function isFavorite(id) {
  return getFavorites().has(id);
}

export function toggleFavorite(id) {
  const s = getFavorites();
  if (s.has(id)) s.delete(id);
  else s.add(id);
  save();
}

export function resetFavorites() {
  cache = null;
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
