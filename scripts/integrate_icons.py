#!/usr/bin/env python3
# 一次性集成脚本：把 src 内残留 emoji 渲染点替换为 SVG 图标（docs/ICON-INTEGRATION.md）
# 每条替换断言恰好命中一次，全部命中后才写盘。
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (relpath, [(old, new)...], import_stmt or None)
JOBS = [
    ('src/tools/merge.js', [
        ('<div class="kv">✅ 合并完成：', '<div class="kv">${iconSvg(\'success\')} 合并完成：'),
    ], "import { iconSvg } from '../components/icons.js';"),
    ('src/tools/office.js', [
        ('kv.innerHTML = `✅ 转换完成：', 'kv.innerHTML = `${iconSvg(\'success\')} 转换完成：'),
    ], "import { iconSvg } from '../components/icons.js';"),
    ('src/tools/ocr.js', [
        ('kv.innerHTML = `✅ 识别完成：', 'kv.innerHTML = `${iconSvg(\'success\')} 识别完成：'),
        ('info.innerHTML = `📄 ${art.name}', 'info.innerHTML = `${iconSvg(\'doc\')} ${art.name}'),
    ], "import { iconSvg } from '../components/icons.js';"),
    ('src/tools/text.js', [
        ('kv.innerHTML = `✅ 提取完成：', 'kv.innerHTML = `${iconSvg(\'success\')} 提取完成：'),
    ], "import { iconSvg } from '../components/icons.js';"),
    ('src/tools/security.js', [
        ('kv.innerHTML = `✅ 完成：', 'kv.innerHTML = `${iconSvg(\'success\')} 完成：'),
    ], "import { iconSvg } from '../components/icons.js';"),
    ('src/tools/compress.js', [
        ('head.innerHTML = `🏆 推荐方案：', 'head.innerHTML = `${iconSvg(\'winner\')} 推荐方案：'),
        ("${isBest ? '🏆' : '·'}", "${isBest ? iconSvg('winner') : '·'}"),
    ], "import { iconSvg } from '../components/icons.js';"),
    ('src/tools/edit.js', [
        ('      b.textContent = `✅ 编辑完成：',
         "      b.appendChild(iconNode('success'));\n      b.appendChild(document.createTextNode(` 编辑完成："),
    ], "import { iconNode } from '../components/icons.js';"),
    ('src/tools/images2pdf.js', [
        ('      kv.textContent = `✅ 转换完成：${items.length}',
         "      kv.appendChild(iconNode('success'));\n      kv.appendChild(document.createTextNode(` 转换完成：${items.length}"),
    ], "import { iconNode } from '../components/icons.js';"),
    ('src/tools/extractimages.js', [
        ("        icon.textContent = '🫙';", "        icon.replaceChildren(iconNode('extractimages'));"),
        ('      kv.textContent = `✅ 提取完成：',
         "      kv.appendChild(iconNode('success'));\n      kv.appendChild(document.createTextNode(` 提取完成："),
        ("        ico.textContent = '🖼';", "        ico.replaceChildren(iconNode('image'));"),
    ], "import { iconNode } from '../components/icons.js';"),
    ('src/tools/overlay.js', [
        ('        b.textContent = `✅ 叠加完成：',
         "        b.appendChild(iconNode('success'));\n        b.appendChild(document.createTextNode(` 叠加完成："),
    ], "import { iconNode } from '../components/icons.js';"),
    ('src/tools/pdf2images.js', [
        ('      kv.textContent = `✅ 转换完成：${arts.length}',
         "      kv.appendChild(iconNode('success'));\n      kv.appendChild(document.createTextNode(` 转换完成：${arts.length}"),
        ("        ico.textContent = '🖼';", "        ico.replaceChildren(iconNode('image'));"),
    ], "import { iconNode } from '../components/icons.js';"),
    ('src/tools/organize.js', [
        ("      button('🗑 删除所选', 'btn-outline btn-sm', () => wb.deleteSelected()),",
         "      (() => { const b = button(' 删除所选', 'btn-outline btn-sm', () => wb.deleteSelected()); b.prepend(iconNode('trash')); return b; })(),"),
    ], "import { iconNode } from '../components/icons.js';"),
    ('src/tools/split.js', [
        ('      b.textContent = `✅ 拆分完成：',
         "      b.appendChild(iconNode('success'));\n      b.appendChild(document.createTextNode(` 拆分完成："),
        ("        ico.textContent = '📄';", "        ico.replaceChildren(iconNode('doc'));"),
    ], "import { iconNode } from '../components/icons.js';"),
    ('src/tools/watermark.js', [
        ("      e.innerHTML = '<div class=\"icon\">💧</div>';",
         "      const ic = document.createElement('div');\n      ic.className = 'icon';\n      ic.appendChild(iconNode('watermark'));\n      e.appendChild(ic);"),
        ('        b.textContent = `✅ 水印应用完成：',
         "        b.appendChild(iconNode('success'));\n        b.appendChild(document.createTextNode(` 水印应用完成："),
        ('renderArtifactCard(art, doc, `✅ 全屏水印完成：', 'renderArtifactCard(art, doc, `全屏水印完成：'),
        ('      b.textContent = summaryText;',
         "      b.appendChild(iconNode('success'));\n      b.appendChild(document.createTextNode(summaryText));"),
    ], "import { iconNode } from '../components/icons.js';"),
    ('src/components/compare-view.js', [
        ("    ok.textContent = '✅ 各页文本内容无差异';",
         "    ok.appendChild(iconNode('success'));\n    ok.appendChild(document.createTextNode(' 各页文本内容无差异'));"),
    ], "import { iconNode } from './icons.js';"),
    ('src/components/pagethumbs.js', [
        ("    mkBtn('🗑 删除所选', () => deleteSelected()),",
         "    (() => { const b = mkBtn(' 删除所选', () => deleteSelected()); b.prepend(iconNode('trash')); return b; })(),"),
    ], "import { iconNode } from './icons.js';"),
    ('src/components/watermark-editor.js', [
        ("    if (miss) incompleteHint.textContent = '⚠ 有图片层缺少图片数据（可能来自预设导入），请在图层参数中重新选择图片，否则该层不会被应用。';",
         "    if (miss) {\n      incompleteHint.replaceChildren(iconNode('warn'), document.createTextNode(' 有图片层缺少图片数据（可能来自预设导入），请在图层参数中重新选择图片，否则该层不会被应用。'));\n    }"),
        ("      icon.textContent = l.type === 'text' ? '🖼'[0] : '🖼';", None),  # 占位防呆，不应命中
        ("      icon.textContent = l.type === 'text' ? 'T' : '🖼';",
         "      if (l.type === 'text') { icon.textContent = 'T'; } else { icon.replaceChildren(iconNode('image')); }"),
        ("      fontHintEl.textContent = '⚠ 文字包含中文：所选字体不含中文字形，导出会失败。建议选择「自动」或「思源黑体（中英文）」。';",
         "      fontHintEl.replaceChildren(iconNode('warn'), document.createTextNode(' 文字包含中文：所选字体不含中文字形，导出会失败。建议选择「自动」或「思源黑体（中英文）」。'));"),
        ("      fontHintEl.textContent = '⚠ 中文字体文件不可用（站点缺少 public/fonts/NotoSansSC），中文水印将无法渲染，请联系部署方补充字体包。';",
         "      fontHintEl.replaceChildren(iconNode('warn'), document.createTextNode(' 中文字体文件不可用（站点缺少 public/fonts/NotoSansSC），中文水印将无法渲染，请联系部署方补充字体包。'));"),
        ("      empty.innerHTML = '<div class=\"icon\">🗂</div>尚未添加水印层<br>点击上方「添加文字层 / 添加图片层」开始';",
         "      empty.innerHTML = '<div class=\"icon\"></div>尚未添加水印层<br>点击上方「添加文字层 / 添加图片层」开始';\n      empty.querySelector('.icon').appendChild(iconNode('watermark'));"),
        ("      ghost.textContent = '🖼 图片水印';",
         "      ghost.replaceChildren(iconNode('image'), document.createTextNode(' 图片水印'));"),
    ], "import { iconNode } from './icons.js';"),
]

total = 0
for rel, reps, imp in JOBS:
    p = ROOT / rel
    s = p.read_text(encoding='utf-8')
    for old, new in reps:
        if new is None:
            continue
        n = s.count(old)
        assert n == 1, f'{rel}: 字面量命中 {n} 次（应为 1）: {old[:60]!r}'
        s = s.replace(old, new, 1)
        total += 1
    if imp and imp not in s:
        lines = s.split('\n')
        for i, ln in enumerate(lines):
            if ln.startswith('import '):
                lines.insert(i, imp)
                break
        else:
            raise AssertionError(f'{rel}: 找不到 import 区')
        s = '\n'.join(lines)
    p.write_text(s, encoding='utf-8')
    print(f'OK {rel}')
print(f'共 {total} 处替换')
