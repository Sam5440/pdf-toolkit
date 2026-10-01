// 密码生成器（更多 · 对齐 PDF24 password-generator）：crypto.getRandomValues 本地生成，无引擎参与
import { registerTool } from '../core.js';
import { field, numberInput, textInput, checkbox, button, toast } from '../../components/ui.js';
import { paramsCard } from './common.js';

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  symbol: '!@#$%^&*()-_=+[]{};:,.<>?/',
};
const AMBIGUOUS = new Set(['0', 'O', '1', 'l', 'I']);

registerTool({
  id: 'passgen',
  name: '密码生成器',
  group: 'more',
  desc: '生成高强度随机密码（纯本地）',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const { card, body } = paramsCard();

    const lenInp = numberInput(16, { min: 8, max: 128, step: 1 });
    lenInp.setAttribute('data-pass-len', '');
    body.appendChild(field('密码长度', lenInp, '8-128 位'));

    const clsRow = document.createElement('div');
    clsRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 8px';
    const upperChk = checkbox('大写 A-Z', true);
    const lowerChk = checkbox('小写 a-z', true);
    const digitChk = checkbox('数字 0-9', true);
    const symbolChk = checkbox('符号 !@#$…', true);
    [upperChk, lowerChk, digitChk, symbolChk].forEach((c) => clsRow.appendChild(c));
    body.appendChild(clsRow);

    const ambChk = checkbox('排除易混字符（0 O 1 l I）', true);
    ambChk._input.setAttribute('data-pass-amb', '');
    body.appendChild(ambChk);

    const genBtn = button('生成密码', 'btn-primary', () => generate());
    genBtn.setAttribute('data-pass-gen', '');
    genBtn.style.cssText = 'width:100%;margin-top:14px';

    const outInp = textInput('');
    outInp.readOnly = true;
    outInp.setAttribute('data-pass-out', '');
    outInp.style.cssText = 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:15px;letter-spacing:1px';
    const outField = field('生成结果', outInp);
    outField.style.marginTop = '12px';

    const copyBtn = button('复制', 'btn-outline', async () => {
      if (!outInp.value) { toast('请先生成密码', 'error'); return; }
      try {
        await navigator.clipboard.writeText(outInp.value);
        toast('已复制到剪贴板');
      } catch {
        // 剪贴板 API 不可用时退回选中文本
        outInp.focus();
        outInp.select();
        document.execCommand?.('copy');
        toast('已选中，请 Ctrl/Cmd+C 复制');
      }
    });
    const outRow = document.createElement('div');
    outRow.style.cssText = 'display:flex;gap:8px;margin-top:8px';
    outRow.append(copyBtn);

    const note = document.createElement('div');
    note.className = 'note';
    note.style.marginTop = '10px';
    note.textContent = '随机数来自 crypto.getRandomValues，生成过程完全在本地完成，不会保存或上传。';

    container.append(card, genBtn, outField, outRow, note);

    /** 安全随机整数 [0, n) */
    function randInt(n) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] % n;
    }

    function generate() {
      const len = Math.min(128, Math.max(8, Math.round(Number(lenInp.value) || 16)));
      const dropAmb = ambChk._input.checked;
      const filter = (s) => (dropAmb ? [...s].filter((c) => !AMBIGUOUS.has(c)).join('') : s);
      const activeSets = [];
      if (upperChk._input.checked) activeSets.push(filter(SETS.upper));
      if (lowerChk._input.checked) activeSets.push(filter(SETS.lower));
      if (digitChk._input.checked) activeSets.push(filter(SETS.digit));
      if (symbolChk._input.checked) activeSets.push(filter(SETS.symbol));
      const sets = activeSets.filter((s) => s.length);
      if (!sets.length) { toast('请至少选择一类字符', 'error'); return; }
      const pool = sets.join('');
      if (pool.length < 4) { toast('可用字符过少，请放宽选项', 'error'); return; }
      const chars = [];
      // 保证每类至少出现一次
      for (const s of sets) {
        if (chars.length < len) chars.push(s[randInt(s.length)]);
      }
      while (chars.length < len) chars.push(pool[randInt(pool.length)]);
      // crypto Fisher-Yates 洗牌
      for (let i = chars.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
      }
      outInp.value = chars.slice(0, len).join('');
    }
  },
});
