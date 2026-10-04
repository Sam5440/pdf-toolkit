// shadcn/ui 控件增强层（vanilla 移植）：
//  - <select>   → shadcn Select（触发器 + fixed Popover；原生 select 保留为
//                 数据/表单/自动化测试锚点，透明覆盖在触发器上）
//  - input[range] → shadcn Slider（CSS 定制轨道/滑块 + --val 填充同步）
//  - input[color] → shadcn 颜色选择器（Popover 色板 + Hex + 系统取色入口）
// 由 MutationObserver 驱动：任何时刻插入 DOM 的原生控件都会被自动增强。

const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** 取 HTMLSelectElement.prototype 上的原生属性描述符（供 value/disabled 代理透传） */
function protoDesc(ctor, prop) {
  let d = null;
  for (let p = ctor.prototype; p && !d; p = Object.getPrototypeOf(p)) {
    d = Object.getOwnPropertyDescriptor(p, prop);
  }
  return d;
}

function proxyProp(el, prop, after) {
  const d = protoDesc(el.constructor, prop);
  if (!d || !d.set) return;
  Object.defineProperty(el, prop, {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) { d.set.call(this, v); after(); },
  });
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

let activeSelPop = null; // 当前打开的 Select Popover（全局同时只开一个）
let activeColorPop = null; // 当前打开的颜色选择器 Popover

function labelOf(sel) {
  const opt = sel.selectedOptions?.[0] || sel.options?.[sel.selectedIndex];
  return opt ? opt.textContent.trim() : '';
}

function closeSelPop() {
  activeSelPop?.close?.();
}

function enhanceSelect(sel) {
  if (sel.dataset.scEnhanced || sel.multiple) return;
  sel.dataset.scEnhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'sc-sel';
  if (sel.style.width) { wrap.style.width = sel.style.width; sel.style.width = ''; }
  if (sel.style.flex) wrap.style.flex = sel.style.flex;
  sel.parentNode.insertBefore(wrap, sel);

  const valueEl = document.createElement('span');
  valueEl.className = 'sc-sel-value';
  const chevron = document.createElement('span');
  chevron.className = 'sc-sel-chevron';
  chevron.innerHTML = CHEVRON_SVG;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sc-sel-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.append(valueEl, chevron);

  sel.setAttribute('data-sc-anchor', '');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');
  wrap.append(trigger, sel);

  const sync = () => {
    valueEl.textContent = labelOf(sel);
    if (sel.disabled) wrap.setAttribute('data-disabled', '');
    else wrap.removeAttribute('data-disabled');
  };
  sel.addEventListener('change', sync);
  proxyProp(sel, 'value', sync);
  proxyProp(sel, 'disabled', sync);

  // 动态改 options（innerHTML / appendChild）后同步触发器文案与已打开的列表
  new MutationObserver(() => {
    sync();
    if (activeSelPop?.owner === sel) renderItems();
  }).observe(sel, { childList: true, subtree: true, characterData: true });

  let pop = null;
  let activeIdx = -1;
  let items = [];

  function renderItems() {
    for (const it of items) it.remove();
    items = [];
    const opts = [...sel.options];
    if (!opts.length) {
      const empty = document.createElement('div');
      empty.className = 'sc-sel-empty';
      empty.textContent = '暂无选项';
      pop.appendChild(empty);
      items.push(empty);
      return;
    }
    opts.forEach((opt, i) => {
      const it = document.createElement('div');
      it.className = 'sc-sel-item';
      it.setAttribute('role', 'option');
      it.tabIndex = -1;
      it.dataset.value = opt.value;
      it.textContent = opt.textContent;
      if (opt.disabled) it.setAttribute('aria-disabled', 'true');
      if (opt.value === sel.value) { it.setAttribute('data-selected', ''); it.setAttribute('aria-selected', 'true'); }
      const check = document.createElement('span');
      check.className = 'sc-sel-check';
      check.innerHTML = CHECK_SVG;
      it.appendChild(check);
      it.addEventListener('click', () => { if (!opt.disabled) pick(opt.value); });
      it.addEventListener('mousemove', () => setActive(i, { focus: false }));
      pop.appendChild(it);
      items.push(it);
    });
  }

  function setActive(i, { focus = true } = {}) {
    activeIdx = i;
    items.forEach((it, j) => {
      if (j === i && !it.hasAttribute('aria-disabled')) it.setAttribute('data-active', '');
      else it.removeAttribute('data-active');
    });
    const cur = items[i];
    if (cur && focus) { cur.focus({ preventScroll: true }); }
    cur?.scrollIntoView?.({ block: 'nearest' });
  }

  function pick(v) {
    if (sel.value !== v) {
      sel.value = v; // 走代理 setter → 同步触发器
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closePop();
    trigger.focus({ preventScroll: true });
  }

  function positionPop() {
    if (!pop) return;
    const r = trigger.getBoundingClientRect();
    pop.style.minWidth = `${r.width}px`;
    const h = pop.offsetHeight;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
    pop.style.top = `${top}px`;
    pop.style.left = `${r.left}px`;
  }

  function openPop() {
    if (pop) return;
    closeSelPop(); // 全局单开
    pop = document.createElement('div');
    pop.className = 'sc-sel-pop';
    pop.setAttribute('role', 'listbox');
    activeIdx = Math.max(0, sel.selectedIndex);
    renderItems();
    document.body.appendChild(pop);
    positionPop();
    wrap.setAttribute('data-open', '');
    activeSelPop = { owner: sel, close: closePop, popEl: pop };
    setActive(activeIdx, { focus: false });
  }

  function closePop() {
    if (pop) { pop.remove(); pop = null; }
    wrap.removeAttribute('data-open');
    if (activeSelPop?.owner === sel) activeSelPop = null;
    window.removeEventListener('scroll', onViewport, true);
    window.removeEventListener('resize', onViewport);
    document.removeEventListener('keydown', onKey);
  }

  function onViewport() { closePop(); }

  function onKey(e) {
    if (!pop) return;
    const opts = [...sel.options];
    const focusable = (i) => !opts[i]?.disabled;
    if (e.key === 'Escape') { e.preventDefault(); closePop(); trigger.focus({ preventScroll: true }); return; }
    if (e.key === 'Tab') { closePop(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      let i = activeIdx;
      for (let n = 0; n < opts.length; n++) {
        i = (i + dir + opts.length) % opts.length;
        if (focusable(i)) break;
      }
      setActive(i);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); for (let i = 0; i < opts.length; i++) if (focusable(i)) return setActive(i); }
    if (e.key === 'End') { e.preventDefault(); for (let i = opts.length - 1; i >= 0; i--) if (focusable(i)) return setActive(i); }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const cur = items[activeIdx];
      if (cur?.dataset.value != null && focusable(activeIdx)) pick(cur.dataset.value);
      return;
    }
    // 首字母 typeahead
    if (/^[\w\u4e00-\u9fa5]$/.test(e.key)) {
      const q = e.key.toLowerCase();
      const start = activeIdx + 1;
      const order = [...opts.keys()].slice(start).concat([...opts.keys()].slice(0, start));
      const hit = order.find((i) => opts[i].textContent.trim().toLowerCase().startsWith(q) && !opts[i].disabled);
      if (hit != null) setActive(hit);
    }
  }

  // 原生 select 透明覆盖在触发器上接收真人点击：preventDefault 压制原生下拉，
  // 由我们打开 shadcn Popover（spike 验证：selectOption 走程序化路径不受影响）
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sel.disabled) return;
    e.preventDefault();
    if (pop) closePop(); else openPop();
  }, true);

  trigger.addEventListener('keydown', (e) => {
    if (pop) return;
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      openPop();
    }
  });

  sync();
}

// ---------------------------------------------------------------------------
// Slider（--val 填充同步）
// ---------------------------------------------------------------------------

function enhanceSlider(r) {
  if (r.dataset.scEnhanced) return;
  r.dataset.scEnhanced = '1';
  const sync = () => {
    const min = parseFloat(r.min || '0');
    const max = parseFloat(r.max || '100');
    const v = parseFloat(r.value || '0');
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    r.style.setProperty('--val', `${Math.max(0, Math.min(100, pct))}%`);
  };
  r.addEventListener('input', sync);
  proxyProp(r, 'value', sync);
  sync();
}

// ---------------------------------------------------------------------------
// 颜色选择器
// ---------------------------------------------------------------------------

const COLOR_PRESETS = [
  '#000000', '#475569', '#94a3b8', '#e2e8f0', '#ffffff',
  '#dc2626', '#ea580c', '#d97706', '#16a34a', '#0d9488',
  '#2563eb', '#7c3aed', '#db2777', '#f43f5e', '#f59e0b',
  '#84cc16', '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6',
  '#fde68a', '#bbf7d0', '#bfdbfe', '#fecdd3',
];

function enhanceColor(inp) {
  if (inp.dataset.scEnhanced) return;
  inp.dataset.scEnhanced = '1';

  const wrap = document.createElement('span');
  wrap.className = 'sc-color';
  if (inp.style.width) { wrap.style.width = inp.style.width; inp.style.width = ''; }
  inp.parentNode.insertBefore(wrap, inp);

  const swatch = document.createElement('span');
  swatch.className = 'sc-color-swatch';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sc-color-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-label', '选择颜色');
  trigger.appendChild(swatch);

  inp.setAttribute('data-sc-anchor', '');
  inp.tabIndex = -1;
  inp.setAttribute('aria-hidden', 'true');
  wrap.append(trigger, inp);

  const sync = () => { swatch.style.background = /^#[0-9a-fA-F]{6}$/.test(inp.value) ? inp.value : '#888888'; };
  inp.addEventListener('input', sync);
  proxyProp(inp, 'value', sync);
  sync();

  let pop = null;

  function closePop() {
    if (!pop) return;
    pop.remove();
    pop = null;
    if (activeColorPop?.owner === inp) activeColorPop = null;
    window.removeEventListener('scroll', onViewport, true);
    window.removeEventListener('resize', onViewport);
  }
  function onViewport() { closePop(); }

  function set(v) {
    const hex = v.startsWith('#') ? v : `#${v}`;
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    if (inp.value.toLowerCase() !== hex.toLowerCase()) {
      inp.value = hex; // 走代理 setter → 同步色板
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync();
    if (pop) {
      const hexInp = pop.querySelector('.sc-color-hex');
      if (hexInp && document.activeElement !== hexInp) hexInp.value = hex.toLowerCase();
    }
  }

  function openPop() {
    if (pop) return;
    pop = document.createElement('div');
    pop.className = 'sc-color-pop';
    pop.setAttribute('role', 'dialog');
    const grid = document.createElement('div');
    grid.className = 'sc-color-grid';
    for (const c of COLOR_PRESETS) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'sc-color-cell';
      cell.style.background = c;
      cell.title = c;
      cell.setAttribute('aria-label', `颜色 ${c}`);
      cell.addEventListener('click', () => set(c));
      grid.appendChild(cell);
    }
    const row = document.createElement('div');
    row.className = 'sc-color-row';
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'sc-color-hex';
    hex.value = inp.value;
    hex.maxLength = 7;
    hex.setAttribute('aria-label', '十六进制颜色值');
    hex.addEventListener('input', () => set(hex.value.trim()));
    hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); set(hex.value.trim()); closePop(); } });
    const custom = document.createElement('button');
    custom.type = 'button';
    custom.className = 'btn btn-outline btn-xs sc-color-custom';
    custom.textContent = '系统取色器';
    custom.addEventListener('click', () => { closePop(); inp.click(); });
    row.append(hex, custom);
    pop.append(grid, row);
    document.body.appendChild(pop);

    const r = trigger.getBoundingClientRect();
    const h = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.min(r.left, window.innerWidth - 244)}px`;

    window.addEventListener('scroll', onViewport, true);
    window.addEventListener('resize', onViewport);
    activeColorPop = { owner: inp, close: closePop, popEl: pop };
  }

  // 原生 input 已 pointer-events:none（真实点击落在触发器上），click 切换弹层；
  // 系统取色器经「系统取色器」按钮程序化 inp.click() 调起。
  trigger.addEventListener('click', () => {
    if (pop) closePop(); else openPop();
  });
}

// ---------------------------------------------------------------------------
// 全局接线：初扫 + MutationObserver（任何时刻插入的原生控件自动增强）
// ---------------------------------------------------------------------------

function pass(root) {
  if (root.nodeType !== 1) return;
  if (root.matches?.('select')) enhanceSelect(root);
  if (root.matches?.('input[type="range"]')) enhanceSlider(root);
  if (root.matches?.('input[type="color"]')) enhanceColor(root);
  if (root.querySelectorAll) {
    root.querySelectorAll('select').forEach(enhanceSelect);
    root.querySelectorAll('input[type="range"]').forEach(enhanceSlider);
    root.querySelectorAll('input[type="color"]').forEach(enhanceColor);
  }
}

let installed = false;
export function initShadcn() {
  if (installed) return;
  installed = true;
  pass(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(pass);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 点击其他区域关闭已打开的 Popover（Popover 挂在 body 上）
  document.addEventListener('pointerdown', (e) => {
    if (activeSelPop) {
      const a = activeSelPop;
      const wrap = a.owner.closest('.sc-sel');
      if (!a.popEl.contains(e.target) && !wrap?.contains(e.target)) a.close();
    }
    if (activeColorPop) {
      const a = activeColorPop;
      const wrap = a.owner.closest('.sc-color');
      if (!a.popEl.contains(e.target) && !wrap?.contains(e.target)) a.close();
    }
  }, true);
}
