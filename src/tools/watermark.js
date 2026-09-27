// 添加水印（代理 B）：单文件输入 + watermark-editor 真实预览 + 应用导出。
// 预览与导出走同一绘制代码路径（composeWatermarkPreview / applyWatermarkMain 共用
// drawWatermarkLayers —— 引擎 wm.apply/wm.preview 存在几何缺陷，绕过方式见编辑器文件头说明）。
import { iconNode } from '../components/icons.js';
import { registerTool } from './core.js';
import { inputPanel } from '../components/input.js';
import { createWatermarkEditor, applyWatermarkMain } from '../components/watermark-editor.js';
import { progressCard, toast, button, field, textInput, numberInput, select } from '../components/ui.js';
import { fmtBytes, todayStr, nowTimeStr } from '../core/format.js';
import { addHistory } from '../core/history.js';
import { downloadArtifact } from '../core/download.js';

registerTool({
  id: 'watermark',
  name: '添加水印',
  group: 'content',
  desc: '文字/图片水印：九宫格/拖动定位、平铺、页范围、真实预览',
  accepts: 'pdf',
  multiple: false,
  render(container) {
    const info = document.createElement('div');
    info.className = 'alert alert-info';
    info.style.marginBottom = '14px';
    info.textContent = '预览即最终效果：编辑器中的预览与导出使用同一绘制代码，所见即所得。全部处理在本地浏览器完成，文件不会上传。';

    const panel = inputPanel({
      multiple: false,
      accept: 'application/pdf,.pdf',
      acceptHint: '选择 1 个 PDF 文件（处理全程在本地浏览器完成）',
    });

    const editorHost = document.createElement('div');
    editorHost.style.marginTop = '14px';
    editorHost.appendChild(emptyHint('请先选择 PDF 文件，即可实时编辑并预览水印'));

    const controls = document.createElement('div');
    controls.className = 'card';
    controls.style.marginTop = '14px';
    const controlsBody = document.createElement('div');
    controlsBody.className = 'card-body';
    const goBtn = button('应用水印', 'btn-primary', () => doApply());
    goBtn.style.width = '100%';
    goBtn.disabled = true;
    controlsBody.appendChild(goBtn);
    controls.appendChild(controlsBody);

    // ── 全屏水印（独立快速模式）：与上方图层编辑器互不影响 ──
    const fsCard = document.createElement('div');
    fsCard.className = 'card';
    fsCard.style.marginTop = '14px';
    const fsBody = document.createElement('div');
    fsBody.className = 'card-body';
    const fsTitle = document.createElement('b');
    fsTitle.style.fontSize = '13.5px';
    fsTitle.textContent = '全屏水印（独立快速模式）';
    const fsHint = document.createElement('div');
    fsHint.className = 'hint';
    fsHint.textContent = '与上方图层模式相互独立：无需在编辑器中添加图层，一键按经典样式（斜排、高密度铺满整页含四角与边缘）给全部页加水印。';
    const fsText = textInput('禁止外传', '水印文字（支持 {页码} {总页数} {文件名}）');
    const fsDensity = numberInput(4, { min: 1, max: 16, step: 1 });
    const fsSize = numberInput(24, { min: 6, max: 200, step: 1 });
    const fsAngle = numberInput(45, { min: -180, max: 180, step: 1 });
    const fsOpacity = numberInput(0.15, { min: 0.01, max: 1, step: 0.01 });
    const fsColor = document.createElement('input');
    fsColor.type = 'color';
    fsColor.value = '#c8c832';
    const fsSide = select(
      [{ value: 'over', label: '前景（内容上方）' }, { value: 'under', label: '背景（内容下方）' }],
      'over',
    );
    const fsGrid = document.createElement('div');
    fsGrid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px';
    fsGrid.append(
      field('水印文字', fsText),
      field('密度（横向列数）', fsDensity),
      field('字号（pt）', fsSize),
      field('角度（°）', fsAngle),
      field('透明度', fsOpacity),
      field('颜色', fsColor),
    );
    const fsSideRow = field('层级', fsSide);
    fsSideRow.style.marginTop = '10px';
    const fsBtn = button('一键全屏水印', 'btn-primary', () => doFullscreenApply());
    fsBtn.style.cssText = 'width:100%;margin-top:12px';
    fsBtn.disabled = true;
    fsBody.append(fsTitle, fsHint, fsGrid, fsSideRow, fsBtn);
    fsCard.appendChild(fsBody);

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '14px';

    container.append(info, panel.el, editorHost, controls, fsCard, resultBox);

    let editor = null;

    function emptyHint(text) {
      const el = document.createElement('div');
      el.className = 'card';
      const b = document.createElement('div');
      b.className = 'card-body';
      const e = document.createElement('div');
      e.className = 'empty';
      const ic = document.createElement('div');
      ic.className = 'icon';
      ic.appendChild(iconNode('watermark'));
      e.appendChild(ic);
      const t = document.createElement('div');
      t.textContent = text;
      e.appendChild(t);
      b.appendChild(e);
      el.appendChild(b);
      return el;
    }

    function mountEditor() {
      const docs = panel.docs();
      editorHost.textContent = '';
      editor = null;
      if (!docs.length) {
        editorHost.appendChild(emptyHint('请先选择 PDF 文件，即可实时编辑并预览水印'));
        updateApplyState();
        return;
      }
      editor = createWatermarkEditor({ doc: docs[0], page: 0, onChange: () => updateApplyState() });
      editorHost.appendChild(editor.el);
      updateApplyState();
    }

    function updateApplyState() {
      const hasDoc = panel.docs().length > 0;
      const hasLayer = !!editor && editor.getSpec().layers.length > 0;
      goBtn.disabled = !(hasDoc && hasLayer);
      goBtn.textContent = hasDoc ? '应用水印' : '应用水印（请先选择文件）';
      fsBtn.disabled = !hasDoc;
      fsBtn.textContent = hasDoc ? '一键全屏水印' : '一键全屏水印（请先选择文件）';
    }

    // inputPanel 不支持后绑定 onAdd/onRemove，这里监听其文件列表 DOM 变化来挂载/卸载编辑器
    const listObserver = new MutationObserver(() => mountEditor());
    listObserver.observe(panel.el.querySelector('.file-list'), { childList: true });

    async function doApply() {
      const docs = panel.docs();
      if (!docs.length) { toast('请先选择 PDF 文件', 'error'); return; }
      const doc = docs[0];
      const spec = editor?.getSpec();
      if (!spec || !spec.layers.length) { toast('请先在编辑器中添加至少一个水印层', 'error'); return; }
      const vars = editor.getVars();
      goBtn.disabled = true;
      resultBox.textContent = '';
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.indeterminate('正在应用水印…');
      const t0 = Date.now();
      try {
        const art = await applyWatermarkMain({ doc, spec, vars });
        pc.done();
        const info = document.createElement('div');
        info.className = 'card';
        const ib = document.createElement('div');
        ib.className = 'card-body';
        const kv = document.createElement('div');
        kv.className = 'kv';
        const b = document.createElement('b');
        b.appendChild(iconNode('success'));
        b.appendChild(document.createTextNode(` 水印应用完成：${spec.layers.length} 个图层 · ${fmtBytes(art.bytes.byteLength)} · 用时 ${Math.round((Date.now() - t0) / 100) / 10}s`));
        kv.appendChild(b);
        const nameRow = document.createElement('div');
        nameRow.className = 'note';
        nameRow.textContent = art.name;
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
        const dl = button('下载水印 PDF', 'btn-primary', () => downloadArtifact(art));
        const save = button('保存到历史', 'btn-outline', async () => {
          await addHistory({
            id: `h_${Date.now().toString(36)}`,
            tool: 'watermark', toolName: '添加水印',
            docNames: docs.map((d) => d.name),
            options: { layers: spec.layers.length, under: spec.layers.filter((l) => l.layerSide === 'under').length },
            outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
          });
          toast('已保存到历史');
        });
        actions.append(dl, save);
        ib.append(kv, nameRow, actions);
        info.appendChild(ib);
        resultBox.appendChild(info);
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        updateApplyState();
      }
    }

    /** 全屏水印（独立模式）：不读取编辑器图层，按快速参数合成单个全屏层 */
    async function doFullscreenApply() {
      const docs = panel.docs();
      if (!docs.length) { toast('请先选择 PDF 文件', 'error'); return; }
      const doc = docs[0];
      const text = fsText.value.trim() || '禁止外传';
      const layer = {
        type: 'text',
        text,
        fontId: 'auto',
        fontSize: Number(fsSize.value) || 24,
        color: fsColor.value,
        opacity: Number(fsOpacity.value) || 0.15,
        bold: false,
        align: 'center',
        anchor: 'mc',
        offsetX: 0,
        offsetY: 0,
        rotation: Number(fsAngle.value) || 0,
        placement: 'fullscreen',
        density: Math.max(1, Math.round(Number(fsDensity.value) || 4)),
        stagger: true,
        layerSide: fsSide.value === 'under' ? 'under' : 'over',
        pages: 'all',
        customRange: '',
      };
      const spec = { layers: [layer] };
      const vars = editor?.getVars?.() || { docName: doc.name, date: todayStr(), time: nowTimeStr() };
      fsBtn.disabled = true;
      resultBox.textContent = '';
      const pc = progressCard();
      resultBox.appendChild(pc.el);
      pc.indeterminate('正在铺满全屏水印…');
      const t0 = Date.now();
      try {
        const art = await applyWatermarkMain({ doc, spec, vars });
        pc.done();
        renderArtifactCard(art, doc, `全屏水印完成：密度 ${layer.density} 列 · ${layer.rotation}° · ${fmtBytes(art.bytes.byteLength)} · 用时 ${Math.round((Date.now() - t0) / 100) / 10}s`, { fullscreen: true, text, density: layer.density, angle: layer.rotation, opacity: layer.opacity, side: layer.layerSide });
      } catch (e) {
        pc.error(e.message);
        if (e.code !== 'ERR_CANCELLED') toast(e.message, 'error');
      } finally {
        updateApplyState();
      }
    }

    function renderArtifactCard(art, docs, summaryText, historyOptions) {
      const info = document.createElement('div');
      info.className = 'card';
      const ib = document.createElement('div');
      ib.className = 'card-body';
      const kv = document.createElement('div');
      kv.className = 'kv';
      const b = document.createElement('b');
      b.appendChild(iconNode('success'));
      b.appendChild(document.createTextNode(summaryText));
      kv.appendChild(b);
      const nameRow = document.createElement('div');
      nameRow.className = 'note';
      nameRow.textContent = art.name;
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
      const dl = button('下载水印 PDF', 'btn-primary', () => downloadArtifact(art));
      const save = button('保存到历史', 'btn-outline', async () => {
        await addHistory({
          id: `h_${Date.now().toString(36)}`,
          tool: 'watermark', toolName: '添加水印',
          docNames: docs.map((d) => d.name),
          options: historyOptions,
          outputs: [{ name: art.name, mime: art.mime, size: art.bytes.byteLength, blob: new Blob([art.bytes], { type: art.mime }) }],
        });
        toast('已保存到历史');
      });
      actions.append(dl, save);
      ib.append(kv, nameRow, actions);
      info.appendChild(ib);
      resultBox.appendChild(info);
    }
  },
});
