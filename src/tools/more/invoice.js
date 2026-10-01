// 发票生成（更多 · 对齐 PDF24 invoice-generator）：条目动态行 → 金额汇总 → blocks → 引擎 text.toPdf
import { registerTool } from '../core.js';
import { run } from '../../core/engine.js';
import { field, numberInput, textInput, button, toast } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

const money = (n) => `¥${Number(n || 0).toFixed(2)}`;

registerTool({
  id: 'invoice',
  name: '发票生成',
  group: 'more',
  desc: '填写发票信息生成 PDF 单据',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { rows: [] };

    const { card: infoCard, body: infoBody } = paramsCard();
    const sellerInp = textInput('', '你的公司 / 姓名');
    sellerInp.setAttribute('data-inv-seller', '');
    infoBody.appendChild(field('卖方', sellerInp));
    const buyerInp = textInput('', '客户公司 / 姓名');
    buyerInp.setAttribute('data-inv-buyer', '');
    infoBody.appendChild(field('买方', buyerInp));
    const taxInp = numberInput(0, { min: 0, max: 100, step: 0.5 });
    taxInp.setAttribute('data-inv-tax', '');
    infoBody.appendChild(field('税率（%）', taxInp, '0-100，可为 0'));
    const noteInp = textInput('', '付款方式、期限等（可选）');
    noteInp.setAttribute('data-inv-note', '');
    infoBody.appendChild(field('备注', noteInp));

    const { card: itemsCard, body: itemsBody } = paramsCard();
    itemsBody.style.marginTop = '14px';
    const title = document.createElement('b');
    title.style.fontSize = '13.5px';
    title.textContent = '条目（名称 / 数量 / 单价）';
    itemsBody.appendChild(title);

    const rowsBox = document.createElement('div');
    rowsBox.style.marginTop = '8px';
    itemsBody.appendChild(rowsBox);
    const addBtn = button('添加条目', 'btn-outline', () => addRow());
    addBtn.setAttribute('data-inv-add', '');
    addBtn.style.marginTop = '8px';
    itemsBody.appendChild(addBtn);

    const sumBox = document.createElement('div');
    sumBox.setAttribute('data-inv-sum', '');
    sumBox.style.cssText = 'margin-top:12px;font-size:13.5px;line-height:1.8';
    itemsBody.appendChild(sumBox);

    const goBtn = button('生成发票 PDF', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';

    const resultBox = document.createElement('div');
    container.append(infoCard, itemsCard, goBtn, resultBox);

    function addRow(name = '', qty = 1, price = 0) {
      const rowEl = document.createElement('div');
      rowEl.setAttribute('data-inv-row', '');
      rowEl.style.cssText = 'display:grid;grid-template-columns:1fr 76px 104px auto;gap:6px;align-items:center;margin-bottom:6px';

      const nameInp = textInput(name, '项目名称');
      nameInp.setAttribute('data-inv-name', '');
      const qtyInp = numberInput(qty, { min: 0, step: 1 });
      qtyInp.setAttribute('data-inv-qty', '');
      qtyInp.placeholder = '数量';
      const priceInp = numberInput(price, { min: 0, step: 0.01 });
      priceInp.setAttribute('data-inv-price', '');
      priceInp.placeholder = '单价';
      const delBtn = button('删除', 'btn-ghost btn-sm', () => {
        state.rows = state.rows.filter((r) => r.row !== rowEl);
        rowEl.remove();
        refreshSummary();
      });
      rowEl.append(nameInp, qtyInp, priceInp, delBtn);
      rowsBox.appendChild(rowEl);
      state.rows.push({ row: rowEl, nameInp, qtyInp, priceInp });
      const upd = () => refreshSummary();
      nameInp.addEventListener('input', upd);
      qtyInp.addEventListener('input', upd);
      priceInp.addEventListener('input', upd);
      refreshSummary();
      return rowEl;
    }

    function collect() {
      return state.rows.map((r) => ({
        name: r.nameInp.value.trim(),
        qty: Number(r.qtyInp.value) || 0,
        price: Number(r.priceInp.value) || 0,
      })).filter((it) => it.name || it.qty || it.price);
    }

    function totals(items) {
      const subtotal = items.reduce((s, it) => s + it.qty * it.price, 0);
      const rate = Math.min(100, Math.max(0, Number(taxInp.value) || 0));
      const tax = subtotal * rate / 100;
      return { subtotal, rate, tax, total: subtotal + tax };
    }

    function refreshSummary() {
      const items = collect();
      if (!items.length) {
        sumBox.textContent = '尚无条目';
        return;
      }
      const { subtotal, rate, tax, total } = totals(items);
      sumBox.replaceChildren();
      const line = (t) => {
        const d = document.createElement('div');
        d.textContent = t;
        return d;
      };
      sumBox.append(
        line(`小计：${money(subtotal)}`),
        line(`税（${rate}%）：${money(tax)}`),
        line(`应收总计：${money(total)}`),
      );
    }

    addRow();

    const exec = runWithProgress(resultBox, async (setP) => {
      const items = collect().filter((it) => it.name);
      if (!items.length) throw new Error('请至少填写一个条目（含名称）');
      const seller = sellerInp.value.trim() || '—';
      const buyer = buyerInp.value.trim() || '—';
      const note = noteInp.value.trim();
      const { subtotal, rate, tax, total } = totals(items);
      setP(15, '排版发票…');

      const rows = [['项目', '数量', '单价', '金额']];
      for (const it of items) {
        rows.push([it.name, String(it.qty), money(it.price), money(it.qty * it.price)]);
      }
      rows.push(['小计', '', '', money(subtotal)]);
      rows.push([`税（${rate}%）`, '', '', money(tax)]);
      rows.push(['应收总计', '', '', money(total)]);

      const blocks = [
        { type: 'h1', text: '发 票' },
        { type: 'p', text: `卖方：${seller}` },
        { type: 'p', text: `买方：${buyer}` },
        { type: 'p', text: `日期：${new Date().toLocaleDateString('zh-CN')}` },
        { type: 'table', rows },
      ];
      if (note) blocks.push({ type: 'p', text: `备注：${note}` });

      const res = await run('text.toPdf', {
        name: '发票',
        blocks,
        paper: 'a4',
        margin: 56,
        fontSize: 11,
        title: `发票 - ${seller}`,
      }, {
        onProgress: (p) => setP(p.total ? 20 + (p.done / p.total) * 80 : 50, p.stage),
      }, new Map());
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 页数: res.summary.pages, 条目: items.length, 总计: money(total) },
        toolId: 'invoice', toolName: '发票生成',
        docNames: [],
        options: { seller, buyer, taxRate: rate, items: items.length },
        extraNote: '此单据为自制格式，不具备税务效力，仅供内部记录与报价使用。',
      }));
      toast('发票 PDF 已生成');
      return res;
    });
  },
});
