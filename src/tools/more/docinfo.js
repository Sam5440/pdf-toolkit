// 修改文档信息（更多 · 对齐 PDF24 edit-metadata）：编辑标题/作者/主题/关键词/创建者
import { registerTool } from '../core.js';
import { run, ensureDoc } from '../../core/engine.js';
import { inputPanel } from '../../components/input.js';
import { field, textInput, button } from '../../components/ui.js';
import { paramsCard, resultCard, runWithProgress } from './common.js';

registerTool({
  id: 'docinfo',
  name: '修改文档信息',
  group: 'more',
  desc: '编辑标题、作者、主题、关键词等元数据',
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

    const mk = (key, label, ph) => {
      const i = textInput('', ph);
      i.setAttribute(`data-di-${key}`, '');
      body.appendChild(field(label, i));
      return i;
    };
    const titleInp = mk('title', '标题', '文档标题');
    const authorInp = mk('author', '作者', '作者名称');
    const subjectInp = mk('subject', '主题', '文档主题');
    const keywordsInp = mk('keywords', '关键词', '多个关键词用逗号分隔');
    const creatorInp = mk('creator', '创建者', '创建应用程序');

    const goBtn = button('开始修改', 'btn-primary', () => exec());
    goBtn.setAttribute('data-di-go', '');
    goBtn.style.cssText = 'width:100%;margin-top:14px';
    goBtn.disabled = true;

    const resultBox = document.createElement('div');
    container.append(panel.el, card, goBtn, resultBox);

    function updateEnable() { goBtn.disabled = !state.doc; }

    const exec = runWithProgress(resultBox, async (setP) => {
      const val = (inp) => String(inp.value ?? '').trim();
      const info = {};
      const pairs = [
        ['title', titleInp], ['author', authorInp], ['subject', subjectInp],
        ['keywords', keywordsInp], ['creator', creatorInp],
      ];
      for (const [k, inp] of pairs) {
        if (val(inp)) info[k] = val(inp); // 空串字段不提交
      }
      if (!Object.keys(info).length) {
        throw Object.assign(new Error('请至少填写一项要修改的信息'), { code: 'ERR_BAD_ARGS' });
      }
      const res = await run('meta.edit', {
        docId: state.doc.id,
        info,
      }, {
        onProgress: (p) => setP(p.total ? (p.done / p.total) * 100 : 0, p.stage),
      }, new Map([[state.doc.id, state.doc]]));
      resultBox.appendChild(resultCard({
        arts: res.artifacts,
        summary: { 字段数: res.summary.fields },
        toolId: 'docinfo', toolName: '修改文档信息',
        docNames: [state.doc.name],
        options: info,
      }));
      return res;
    });
  },
});
