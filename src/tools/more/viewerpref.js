// 查看器偏好（更多 · 对齐 PDF24 viewer-prefs）：设置 PageMode/PageLayout 与窗口布尔项
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, button, select, checkbox } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'viewerpref',
  name: '查看器偏好',
  group: 'more',
  desc: '设置打开方式：单页/双页、全屏、隐藏工具栏等',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const state = { doc: null };

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
      async onAdd(added) {
        if (!added.length) return;
        state.doc = added[added.length - 1];
        updateEnable();
      },
      onRemove() { state.doc = null; updateEnable(); },
    });

    const { card, body } = paramsCard();

    const pageModeSel = select([
      { value: 'UseNone', label: '默认视图' },
      { value: 'UseOutlines', label: '书签面板' },
      { value: 'UseThumbs', label: '缩略图面板' },
      { value: 'FullScreen', label: '全屏模式' },
    ], 'UseNone');
    pageModeSel.setAttribute('data-vp-pagemode', '');
    body.appendChild(field('默认视图（PageMode）', pageModeSel, '阅读器打开文档时优先显示的面板'));

    const pageLayoutSel = select([
      { value: 'SinglePage', label: '单页' },
      { value: 'OneColumn', label: '单列连续' },
      { value: 'TwoColumnLeft', label: '双列（封面在左）' },
      { value: 'TwoColumnRight', label: '双列（封面在右）' },
    ], 'SinglePage');
    pageLayoutSel.setAttribute('data-vp-pagelayout', '');
    body.appendChild(field('页面布局（PageLayout）', pageLayoutSel));

    const mkCk = (key, label) => {
      const ck = checkbox(label);
      ck._input.setAttribute(`data-vp-${key}`, '');
      ck.style.marginBottom = '8px';
      body.appendChild(ck);
      return ck._input;
    };
    const hideToolbar = mkCk('hidetoolbar', '隐藏工具栏（hideToolbar）');
    const hideMenubar = mkCk('hidemenubar', '隐藏菜单栏（hideMenubar）');
    const fitWindow = mkCk('fitwindow', '自适应窗口大小（fitWindow）');
    const centerWindow = mkCk('centerwindow', '窗口居中（centerWindow）');
    const displayDocTitle = mkCk('displaydoctitle', '窗口标题显示文档名（displayDocTitle）');

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '未勾选的布尔项不会写入，保持阅读器默认行为。';
    body.appendChild(hint);

    const goBtn = button('开始设置', 'btn-primary', () => exec());
    goBtn.setAttribute('data-vp-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const prefs = {
        pageMode: pageModeSel.value,
        pageLayout: pageLayoutSel.value,
      };
      // 未勾选的布尔项不传（undefined），引擎保持阅读器默认
      if (hideToolbar.checked) prefs.hideToolbar = true;
      if (hideMenubar.checked) prefs.hideMenubar = true;
      if (fitWindow.checked) prefs.fitWindow = true;
      if (centerWindow.checked) prefs.centerWindow = true;
      if (displayDocTitle.checked) prefs.displayDocTitle = true;
      const res = await run('viewer.prefs', {
        docId: state.doc.id,
        prefs,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: {},
        toolId: 'viewerpref', toolName: '查看器偏好',
        docNames: [state.doc.name],
        options: prefs,
        extraNote: '偏好保存在 PDF 目录字典中，支持的阅读器打开时将按设置展示。',
      }));
      return res;
    });
  },
});
