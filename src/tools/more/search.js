// PDF 搜索（更多 · 对齐 PDF24 search-pdf）：全册搜索，显示页码与上下文摘要
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import {
  field, textInput, checkbox, button, progressCard, toast,
} from '../../components/ui.js';

registerTool({
  id: 'search',
  name: 'PDF 搜索',
  group: 'm-view',
  desc: '全册搜索文字，显示页码与上下文',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0 };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（搜索全程在本地完成）',
      async onAdd(added) {
        state.doc = added[added.length - 1];
        state.pageCount = 0;
        try {
          const info = await ensureDoc(state.doc);
          state.doc.info = info;
          state.pageCount = info.pageCount;
        } catch { /* 上层已 toast */ }
        updateEnable();
      },
      onRemove() { state.doc = null; state.pageCount = 0; updateEnable(); },
    });

    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginTop = '14px';
    const body = document.createElement('div');
    body.className = 'card-body';

    const qInp = textInput('', '输入搜索词');
    qInp.setAttribute('data-se-query', '');
    body.appendChild(field('搜索词', qInp));

    const optRow = document.createElement('div');
    optRow.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap';
    const csCb = checkbox('区分大小写', false);
    csCb._input.setAttribute('data-se-case', '');
    const reCb = checkbox('正则表达式', false);
    reCb._input.setAttribute('data-se-regex', '');
    optRow.append(csCb, reCb);
    body.appendChild(field('选项', optRow));

    const pagesInp = textInput('', '留空 = 全部；如 1-3,5');
    pagesInp.setAttribute('data-se-pages', '');
    body.appendChild(field('页码范围', pagesInp, '留空搜索全部页'));

    card.appendChild(body);

    const goBtn = button('开始搜索', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    async function exec() {
      const query = qInp.value.trim();
      if (!query) { toast('请输入搜索词', 'error'); return; }
      goBtn.disabled = true;
      resultBox.textContent = '';
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.set(5, '开始搜索…');
      try {
        let res;
        try {
          res = await run('search.run', {
            docId: state.doc.id,
            query,
            pages: pagesInp.value.trim() || 'all',
            caseSensitive: csCb._input.checked,
            regex: reCb._input.checked,
          }, {
            onProgress: (p) => pc.set(p.total ? (p.done / p.total) * 100 : 50, p.stage),
          }, new Map([[state.doc.id, state.doc]]));
        } catch (e) {
          // 引擎缺陷绕过：engine-more 的 search.run 引用未导入的 pdfjsOpen（ReferenceError）。
          // 回退：用 text.extract 的逐页行文本在本地计数/摘要（结果结构一致）。
          res = await localSearch(query);
        }
        pc.done();
        renderResults(res, query);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        goBtn.disabled = !state.doc;
      }
    }

    /** 本地搜索：text.extract 逐页行文本 → 计数 + 上下文摘要 */
    async function localSearch(query) {
      const res = await run('text.extract', {
        docId: state.doc.id,
        pages: pagesInp.value.trim() || 'all',
      }, {}, new Map([[state.doc.id, state.doc]]));
      const caseSensitive = csCb._input.checked;
      const useRe = reCb._input.checked;
      let re = null;
      if (useRe) {
        try { re = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch (err) { throw new Error(`正则无效：${err.message}`); }
      }
      const needle = caseSensitive ? query : query.toLowerCase();
      const hits = [];
      let total = 0;
      for (const p of res.pages) {
        const text = String(p.text || '').replace(/\n/g, '');
        const haystack = caseSensitive ? text : text.toLowerCase();
        const found = [];
        if (re) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(text)) && found.length < 200) {
            found.push(m.index);
            if (m.index === re.lastIndex) re.lastIndex++;
          }
        } else {
          let idx = haystack.indexOf(needle);
          while (idx !== -1 && found.length < 200) {
            found.push(idx);
            idx = haystack.indexOf(needle, idx + needle.length);
          }
        }
        if (found.length) {
          const snippets = found.slice(0, 8).map((idx) => {
            const s = Math.max(0, idx - 24);
            return `${s > 0 ? '…' : ''}${text.slice(s, idx + query.length + 24)}${idx + query.length + 24 < text.length ? '…' : ''}`;
          });
          hits.push({ page: p.page, count: found.length, snippets });
          total += found.length;
        }
      }
      return { hits, total, query };
    }

    function renderResults(res, query) {
      const box = document.createElement('div');
      box.className = 'card';
      box.setAttribute('data-search-results', '');
      const ib = document.createElement('div');
      ib.className = 'card-body';

      if (!res.hits.length) {
        const empty = document.createElement('div');
        empty.className = 'note';
        empty.setAttribute('data-search-empty', '');
        empty.textContent = `未找到「${query}」— 没有任何匹配。可尝试更短的关键词、关闭「区分大小写」，或改用正则。`;
        ib.appendChild(empty);
        box.appendChild(ib);
        resultBox.appendChild(box);
        return;
      }

      const head = document.createElement('div');
      head.className = 'kv';
      const b = document.createElement('b');
      b.setAttribute('data-search-total', '');
      b.textContent = `共 ${res.total} 处命中，分布于 ${res.hits.length} 页（「${query}」）`;
      head.appendChild(b);
      ib.appendChild(head);

      const list = document.createElement('div');
      list.style.marginTop = '10px';
      for (const hit of res.hits) {
        const rowEl = document.createElement('div');
        rowEl.className = 'result-artifact';
        const info = document.createElement('div');
        info.className = 'ra-info';
        const nm = document.createElement('div');
        nm.className = 'ra-name';
        nm.textContent = `第 ${hit.page + 1} 页 × ${hit.count}`;
        const meta = document.createElement('div');
        meta.className = 'ra-meta';
        meta.style.cssText = 'white-space:normal';
        meta.textContent = hit.snippets.join('\n');
        info.append(nm, meta);
        rowEl.appendChild(info);
        list.appendChild(rowEl);
      }
      ib.appendChild(list);
      box.appendChild(ib);
      resultBox.appendChild(box);
    }
  },
});
