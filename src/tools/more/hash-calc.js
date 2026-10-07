// 哈希计算（更多 · MD5/SHA-1/SHA-256/SHA-512）：hash-wasm 本地计算，文件分块流式读取
import { registerTool } from '../core.js';
import { md5, sha1, sha256, sha512, createMD5, createSHA1, createSHA256, createSHA512 } from 'hash-wasm';
import { inputPanel } from '../../components/input.js';
import { field, select, checkbox, button, toast } from '../../components/ui.js';
import { paramsCard } from './common.js';
import { recordTaskOrButton, recordNote, capturePageForm } from '../../core/tasklog.js';

const ALGOS = [
  { id: 'md5', label: 'MD5', quick: md5, stream: createMD5 },
  { id: 'sha1', label: 'SHA-1', quick: sha1, stream: createSHA1 },
  { id: 'sha256', label: 'SHA-256', quick: sha256, stream: createSHA256 },
  { id: 'sha512', label: 'SHA-512', quick: sha512, stream: createSHA512 },
];

const CHUNK = 4 * 1024 * 1024; // 文件分块大小（流式 hash，不整读内存）

export async function hashBytes(make, bytes) {
  return make(bytes);
}

export async function hashFile(make, file) {
  const h = await make();
  h.init();
  for (let off = 0; off < file.size; off += CHUNK) {
    const buf = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
    h.update(buf);
  }
  return h.digest('hex');
}

registerTool({
  id: 'hash-calc',
  name: '哈希计算',
  group: 'm-util',
  desc: '计算文本/文件的 MD5、SHA-1、SHA-256、SHA-512，本地分块处理',
  accepts: 'pdf',
  multiple: false,
  defaultFav: true,
  render(container) {
    const state = { docs: [] };

    const panel = inputPanel({
      multiple: true,
      accept: '*/*',
      acceptTest: /.*/, // 任意文件都可算哈希
      acceptHint: '可多选任意文件（分块流式读取，适合大文件）',
      onAdd() { state.docs = panel.docs(); syncMode(); },
      onRemove() { state.docs = panel.docs(); syncMode(); },
    });

    const { card, body } = paramsCard();

    const modeSel = select([
      { value: 'text', label: '计算文本哈希' },
      { value: 'file', label: '计算文件哈希' },
    ], 'text');
    modeSel.setAttribute('data-hash-mode', '');
    body.appendChild(field('输入类型', modeSel));

    const txt = document.createElement('textarea');
    txt.rows = 4;
    txt.placeholder = '输入要计算哈希的文本';
    txt.setAttribute('data-hash-text', '');
    body.appendChild(field('文本', txt, 'UTF-8 编码后计算，与命令行 md5sum 等结果一致'));

    const algoChecks = [];
    const algoBox = document.createElement('div');
    algoBox.className = 'field';
    const algoLabel = document.createElement('label');
    algoLabel.textContent = '算法';
    algoBox.appendChild(algoLabel);
    for (const a of ALGOS) {
      const c = checkbox(a.label, true);
      algoChecks.push({ a, c: c._input });
      algoBox.appendChild(c);
    }
    body.appendChild(algoBox);

    const goBtn = button('计算哈希', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function syncMode() {
      const isFile = modeSel.value === 'file';
      panel.el.style.display = isFile ? '' : 'none';
      txt.disabled = !isFile ? false : true;
      txt.parentElement.style.display = isFile ? 'none' : '';
      goBtn.disabled = isFile && !state.docs.length;
    }
    modeSel.addEventListener('change', syncMode);
    syncMode();

    function hashRow(label, hex) {
      const line = document.createElement('div');
      line.className = 'result-artifact';
      const info = document.createElement('div');
      info.className = 'ra-info';
      const nm = document.createElement('div');
      nm.className = 'ra-name';
      nm.textContent = label;
      const meta = document.createElement('div');
      meta.className = 'ra-meta';
      meta.style.wordBreak = 'break-all';
      meta.textContent = hex;
      info.append(nm, meta);
      line.append(info, button('复制', 'btn-outline btn-sm', async () => {
        try { await navigator.clipboard.writeText(hex); toast('已复制到剪贴板'); }
        catch { toast('复制失败', 'error'); }
      }));
      return line;
    }

    async function exec() {
      resultBox.replaceChildren();
      const algos = algoChecks.filter((x) => x.c.checked).map((x) => x.a);
      if (!algos.length) { toast('请至少选择一种算法', 'error'); return; }
      const isFile = modeSel.value === 'file';
      const docs = isFile ? [...state.docs] : [];
      if (isFile && !docs.length) { toast('请先选择文件', 'error'); return; }
      if (!isFile && !txt.value.length) { toast('请输入文本', 'error'); return; }

      const cardEl = document.createElement('div');
      cardEl.className = 'card';
      const bodyEl = document.createElement('div');
      bodyEl.className = 'card-body';
      const inputs = isFile ? docs.map((d) => ({ name: d.name, file: d.file, size: d.file.size }))
        : [{ name: `文本（${txt.value.length} 字符）`, bytes: new TextEncoder().encode(txt.value) }];
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i];
        const head = document.createElement('div');
        head.className = 'hint';
        head.style.cssText = `margin-top:${i ? '12px' : '2px'};`;
        head.textContent = inp.name;
        bodyEl.appendChild(head);
        for (const a of algos) {
          try {
            const hex = isFile ? await hashFile(a.stream, inp.file) : await hashBytes(a.quick, inp.bytes);
            bodyEl.appendChild(hashRow(a.label, hex));
          } catch (e) {
            const err = document.createElement('div');
            err.className = 'alert alert-error';
            err.style.marginTop = '4px';
            err.textContent = `${a.label} 计算失败：${e.message || e}`;
            bodyEl.appendChild(err);
          }
        }
      }
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
      recordTaskOrButton({
        tool: 'hash-calc', toolName: '哈希计算',
        docNames: docs.map((d) => d.name),
        options: { 输入: isFile ? `文件 ${docs.length} 个` : '文本', 算法: algos.map((a) => a.label).join('/') },
        docs,
        outputs: [],
        form: capturePageForm(),
      }).then((btn) => {
        if (btn) actions.appendChild(btn);
        else bodyEl.appendChild(recordNote());
      }).catch(() => { /* 记录失败不阻塞结果展示 */ });
      bodyEl.appendChild(actions);
      cardEl.appendChild(bodyEl);
      resultBox.appendChild(cardEl);
    }
  },
});
