// shadcn Command（cmdk）风格全局搜索面板：⌘K / 顶栏按钮唤起。
// 覆盖全部工具（名称/介绍/关键词匹配）+ 快捷操作（主题切换/更多工具页/历史/设置/仓库）。
import { TOOLS, GROUPS } from '../tools/core.js';
import { SEARCH_INTROS, SEARCH_KEYWORDS } from '../core/search-data.js';
import { getFavorites } from '../core/favorites.js';
import { iconNode } from './icons.js';

const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const GITHUB_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.15c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.66.41.35.78 1.05.78 2.12v3.14c0 .3.2.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>';

let INDEX = null;
function norm(s) { return (s || '').toLowerCase(); }

function buildIndex() {
  if (INDEX) return INDEX;
  const groupOf = (id) => GROUPS.find((g) => g.id === id);
  INDEX = [
    ...TOOLS.map((t) => ({
      kind: 'tool',
      id: t.id,
      name: t.name,
      nameL: norm(t.name),
      desc: t.desc || '',
      descL: norm(t.desc || ''),
      intro: SEARCH_INTROS[t.id] || '',
      introL: norm(SEARCH_INTROS[t.id] || ''),
      kws: SEARCH_KEYWORDS[t.id] || [],
      group: groupOf(t.group),
      fav: !!t.defaultFav,
    })),
  ];
  return INDEX;
}

const QUICK_ACTIONS = [
  { kind: 'action', id: 'act-theme', name: '切换深色 / 浅色主题', desc: '在外观主题之间切换', kws: ['主题', '深色', '浅色', '暗色', 'theme', 'dark', 'light', '夜间'], run: (ctx) => ctx.toggleTheme() },
  { kind: 'action', id: 'act-more', name: '更多工具页', desc: '浏览全部扩展功能并管理收藏', kws: ['更多', '全部功能', '工具列表', 'more'], run: () => { location.hash = '#/more'; } },
  { kind: 'action', id: 'act-history', name: '历史记录', desc: '查看与下载历史处理结果', kws: ['历史', '记录', 'history', '下载过'], run: () => { location.hash = '#/history'; } },
  { kind: 'action', id: 'act-settings', name: '打开设置', desc: '主题、图标、性能上限与版本信息', kws: ['设置', '偏好', 'settings', '配置', '版本'], run: (ctx) => ctx.openSettings?.() },
  { kind: 'action', id: 'act-repo', name: 'GitHub 仓库', desc: 'github.com/Sam5440/pdf-toolkit', kws: ['github', '仓库', '源码', '开源', 'repo', 'issue'], run: () => window.open('https://github.com/Sam5440/pdf-toolkit', '_blank', 'noopener') },
];

function scoreItem(item, tokens) {
  if (!tokens.length) return item.fav ? 50 : (item.kind === 'action' ? 45 : 0);
  let total = 0;
  for (const tok of tokens) {
    let best = 0;
    if (item.kind === 'action' || item.kind === 'tool') {
      if (item.nameL.startsWith(tok)) best = 120;
      else if (item.nameL.includes(tok)) best = 90;
    }
    if (item.kwsL.some((k) => k === tok)) best = Math.max(best, 85);
    else if (item.kwsL.some((k) => k.startsWith(tok))) best = Math.max(best, 70);
    else if (item.kwsL.some((k) => k.includes(tok))) best = Math.max(best, 55);
    if (item.descL.includes(tok)) best = Math.max(best, 40);
    if (item.introL?.includes(tok)) best = Math.max(best, 30);
    if (!best) return 0; // AND 语义：每个词都必须命中
    total += best;
  }
  return total + (item.fav ? 4 : 0);
}

/** 搜索：返回按得分排序的 {item, s} 列表（空查询 = 当前收藏工具 + 快捷操作） */
export function search(query) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  const favs = getFavorites();
  const pool = [
    ...buildIndex().map((t) => ({
      ...t,
      kwsL: t.kws.map(norm),
      fav: favs.has(t.id), // 空查询展示与首页一致：用户当前收藏集
    })),
    ...QUICK_ACTIONS.map((a) => ({ ...a, nameL: norm(a.name), descL: norm(a.desc), kwsL: a.kws.map(norm) })),
  ];
  const scored = pool
    .map((item) => ({ item, s: scoreItem(item, tokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.item.name.localeCompare(b.item.name, 'zh'));
  if (!tokens.length) return scored;
  return scored.slice(0, 30);
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 名称中命中 token 的片段加 <mark>（安全 DOM 构建） */
function highlightedName(name, tokens) {
  if (!tokens.length) return [document.createTextNode(name)];
  const frags = [];
  const reg = new RegExp(`(${tokens.map(escapeReg).join('|')})`, 'ig');
  let last = 0;
  for (const m of name.matchAll(reg)) {
    if (m.index > last) frags.push(document.createTextNode(name.slice(last, m.index)));
    const mark = document.createElement('mark');
    mark.textContent = m[0];
    frags.push(mark);
    last = m.index + m[0].length;
  }
  if (last < name.length) frags.push(document.createTextNode(name.slice(last)));
  return frags;
}

/** 打开命令面板。ctx: { toggleTheme } */
export function openCommandPalette(ctx = {}) {
  if (document.querySelector('.cmdk-mask')) return;
  const mask = document.createElement('div');
  mask.className = 'cmdk-mask';
  const box = document.createElement('div');
  box.className = 'cmdk';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', '搜索工具');

  // 输入行
  const row = document.createElement('div');
  row.className = 'cmdk-input-row';
  const ico = document.createElement('span');
  ico.className = 'cmdk-ico';
  ico.innerHTML = SEARCH_SVG;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '搜索功能：压缩、水印、转 Word、OCR…（支持空格分隔多关键词）';
  input.setAttribute('aria-label', '搜索功能');
  const esc = document.createElement('span');
  esc.className = 'kbd';
  esc.textContent = 'esc';
  row.append(ico, input, esc);

  // 结果列表
  const list = document.createElement('div');
  list.className = 'cmdk-list';
  list.setAttribute('role', 'listbox');

  // 底部键位提示
  const foot = document.createElement('div');
  foot.className = 'cmdk-foot';
  const mkHint = (t) => { const s = document.createElement('span'); s.className = 'kbd'; s.textContent = t; return s; };
  foot.append(
    mkHint('↑↓'), Object.assign(document.createElement('span'), { textContent: '选择' }),
    mkHint('↵'), Object.assign(document.createElement('span'), { textContent: '打开' }),
    Object.assign(document.createElement('span'), { className: 'spacer' }),
    Object.assign(document.createElement('span'), { textContent: `${TOOLS.length} 个功能 · 本地处理` }),
  );

  box.append(row, list, foot);
  mask.appendChild(box);
  document.body.appendChild(mask);

  const close = () => {
    mask.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  const tokensOf = () => norm(input.value).split(/\s+/).filter(Boolean);
  let flat = [];   // [{el, run}]
  let activeIdx = 0;

  function render() {
    const tokens = tokensOf();
    const results = search(input.value);
    list.textContent = '';
    flat = [];
    const addGroup = (label, items) => {
      if (!items.length) return;
      const lab = document.createElement('div');
      lab.className = 'cmdk-group-label';
      lab.textContent = label;
      list.appendChild(lab);
      for (const { item } of items) {
        const el = document.createElement('div');
        el.className = 'cmdk-item';
        el.setAttribute('role', 'option');
        el.tabIndex = -1;
        const ic = document.createElement('span');
        ic.className = 'ci-ico';
        if (item.kind === 'tool') ic.appendChild(iconNode(item.id));
        else ic.innerHTML = SEARCH_SVG;
        const main = document.createElement('div');
        main.className = 'ci-main';
        const nameEl = document.createElement('div');
        nameEl.className = 'ci-name';
        nameEl.append(...highlightedName(item.name, tokens));
        const descEl = document.createElement('div');
        descEl.className = 'ci-desc';
        descEl.textContent = item.kind === 'tool' ? (tokens.length && item.intro ? item.intro : item.desc) : item.desc;
        main.append(nameEl, descEl);
        const grp = document.createElement('span');
        grp.className = 'ci-group';
        grp.textContent = item.kind === 'tool' ? (item.group?.name || '') : '操作';
        el.append(ic, main, grp);
        const run = () => {
          close();
          if (item.kind === 'tool') location.hash = `#/tool/${item.id}`;
          else item.run(ctx);
        };
        el.addEventListener('click', run);
        el.addEventListener('mousemove', () => setActive(flat.findIndex((f) => f.el === el), { focus: false }));
        list.appendChild(el);
        flat.push({ el, run });
      }
    };
    if (!tokens.length) {
      addGroup('收藏的工具', results.filter((r) => r.item.kind === 'tool'));
      addGroup('快捷操作', results.filter((r) => r.item.kind === 'action'));
    } else {
      // 按分组聚合（保持 GROUPS 顺序），分数已排序
      const seen = new Set();
      for (const g of GROUPS) {
        const items = results.filter((r) => r.item.kind === 'tool' && r.item.group?.id === g.id && !seen.has(r.item.id));
        items.forEach((i) => seen.add(i.item.id));
        addGroup(g.name, items);
      }
      addGroup('其他', results.filter((r) => !seen.has(r.item.id) || r.item.kind === 'action'));
    }
    if (!flat.length) {
      const empty = document.createElement('div');
      empty.className = 'cmdk-empty';
      empty.textContent = `没有匹配「${input.value.trim()}」的功能，换个关键词试试`;
      list.appendChild(empty);
    }
    setActive(0, { focus: false });
  }

  function setActive(i, { focus = true } = {}) {
    activeIdx = Math.max(0, Math.min(flat.length - 1, i));
    flat.forEach((f, j) => {
      if (j === activeIdx) f.el.setAttribute('data-active', '');
      else f.el.removeAttribute('data-active');
    });
    const cur = flat[activeIdx];
    if (cur && focus) cur.el.focus({ preventScroll: true });
    cur?.el.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (document.activeElement !== input) return; // 输入框外仅处理 Esc
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); return; }
    if (e.key === 'Enter') { e.preventDefault(); flat[activeIdx]?.run(); }
  }

  input.addEventListener('input', render);
  document.addEventListener('keydown', onKey, true);
  render();
  input.focus();
}

/** 顶栏搜索按钮 */
export function commandPaletteButton(ctx = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-outline btn-sm tb-search';
  b.setAttribute('aria-label', '搜索工具');
  b.title = '搜索功能（⌘K）';
  const ic = document.createElement('span');
  ic.className = 'tb-search-ico';
  ic.style.cssText = 'display:inline-flex;width:14px;height:14px;color:var(--muted-foreground)';
  ic.innerHTML = SEARCH_SVG;
  const label = document.createElement('span');
  label.className = 'tb-search-text';
  label.textContent = '搜索工具…';
  const kbd = document.createElement('span');
  kbd.className = 'kbd';
  kbd.textContent = '⌘K';
  b.append(ic, label, kbd);
  b.onclick = () => openCommandPalette(ctx);
  return b;
}

/** GitHub 仓库图标按钮（对齐 shadcn.com 顶栏） */
export function githubButton() {
  const a = document.createElement('a');
  a.className = 'btn btn-ghost btn-sm btn-icon';
  a.href = 'https://github.com/Sam5440/pdf-toolkit';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', 'GitHub 仓库');
  a.title = 'GitHub 仓库（Sam5440/pdf-toolkit）';
  a.innerHTML = GITHUB_SVG;
  a.style.cssText = 'color:var(--muted-foreground)';
  return a;
}
