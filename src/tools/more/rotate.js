// 旋转/镜像 PDF（更多 · 对齐 PDF24 rotate-pdf-pages）：页范围 + 90/180/270°（0/360°=不旋转）+ 左右/上下镜像
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, numberInput, button, select, checkbox, row } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'rotate',
  name: '旋转 PDF',
  group: 'm-page',
  desc: '按页范围旋转 90/180/270°，支持左右/上下镜像',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null, pageCount: 0 };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
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

    const { card, body } = paramsCard();
    const pagesInp = numberInput('', { min: 1, step: 1 });
    pagesInp.placeholder = '留空 = 全部；如 1-3,5';
    pagesInp.dataset.rotPages = '';
    body.appendChild(field('页码范围', pagesInp, '仅处理所选页；留空处理全部页'));

    const angleSel = select([
      { value: '90', label: '顺时针 90°' },
      { value: '180', label: '180°' },
      { value: '270', label: '顺时针 270°' },
      { value: '0', label: '不旋转（0° / 360°）' },
    ], '90');
    angleSel.dataset.rotAngle = '';
    body.appendChild(field('旋转角度', angleSel, '360° 与 0° 等价，即保持原方向'));

    const mirrorX = checkbox('左右镜像（正反 / 水平翻转）');
    mirrorX._input.dataset.rotMirrorX = '';
    const mirrorY = checkbox('上下镜像（垂直翻转）');
    mirrorY._input.dataset.rotMirrorY = '';
    body.appendChild(field('镜像翻转', row(mirrorX, mirrorY), '两项同选相当于点对称（等价旋转 180°）'));

    const modeSel = select([
      { value: 'relative', label: '相对当前方向累加' },
      { value: 'absolute', label: '设为绝对角度' },
    ], 'relative');
    modeSel.dataset.rotMode = '';
    body.appendChild(field('旋转模式', modeSel, '仅影响旋转角度；镜像始终对可视方向生效'));

    const goBtn = button('开始旋转', 'btn-primary', () => exec());
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const res = await run('pages.rotate', {
        docId: state.doc.id,
        pages: pagesInp.value.trim() || 'all',
        angle: Number(angleSel.value),
        mode: modeSel.value,
        mirrorX: mirrorX._input.checked,
        mirrorY: mirrorY._input.checked,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      const card2 = resultCard({
        arts: res.artifacts,
        summary: {
          页数: res.summary.pages,
          角度: `${res.summary.angle}°`,
          镜像: res.summary.mirror,
        },
        toolId: 'rotate', toolName: '旋转 PDF',
        docNames: [state.doc.name],
        options: {
          pages: pagesInp.value, angle: angleSel.value, mode: modeSel.value,
          mirrorX: mirrorX._input.checked, mirrorY: mirrorY._input.checked,
        },
      });
      resultBox.appendChild(card2);
      return res;
    });
  },
});
