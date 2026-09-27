# 图标集成映射表（集成时逐点替换，替换完成标准：`grep -rnP '[\x{1F300}-\x{1FAFF}]' src/` 仅剩 ✕/✓ 文本符号）

## 图标清单（26 个 = 15 工具 + 8 壳层 + 3 通用）
工具：merge split organize edit watermark overlay compress security office ocr text images2pdf pdf2images extractimages compare
壳层：logo history settings upload theme(moon+sun 两文件) success winner doc
通用：trash(删除按钮) warn(⚠ 提示) image(🖼 产物/图片层占位)

## 替换点

### 注册表 icon 字段（15 个）→ `iconNode(t.id)`
tools/*.js 的 `icon: '📑'` 等字段删除，改为 icons.js 按 tool.id 查找。

### main.js 壳层
- :75 主题按钮 ☀️/🌙 → `iconNode('sun'/'moon')` + 文本「浅色/深色」
- :80 🕘 历史 → `iconNode('history')` + 「历史」
- :81 ⚙️ 设置 → `iconNode('settings')` + 「设置」
- :114 🔒 → `iconNode('lock')`?（待定：security 图标复用或 doc）→ 用 security
- :137 ⏳ → `<span class="spinner"></span>`
- :152 🕘 空历史 → `iconNode('history')`（empty-ico 容器）
- :175 ra-ico 📄 → `iconNode('doc')`

### 通用 ✅ 成功提示（innerHTML 处嵌 `ICONS.success`，textContent 处 prepend iconNode）
security.js:124 merge.js:62 office.js:228 overlay.js:319 organize.js:167 split.js:228
watermark.js:162/229 edit.js:746 pdf2images.js:175 ocr.js:129 extractimages.js:169
images2pdf.js:236 text.js:96 compare-view.js:181

### 工具内部小 emoji
- organize.js:90 + pagethumbs.js:274 🗑 → `iconNode('trash')`
- compress.js:165/249 🏆 → `iconNode('winner')`
- split.js:239 📄、ocr.js:148 📄 → `iconNode('doc')`
- pdf2images.js:185、extractimages.js:177、watermark-editor.js:953/1454 🖼 → `iconNode('image')`
- extractimages.js:153 🫙 → `iconNode('extractimages')`（empty-ico）
- watermark.js:103 💧 → `iconNode('watermark')`（empty-ico）
- watermark-editor.js:1189 🗂 → `iconNode('overlay')`? → 用 layer 概念，复用 edit 或 organize；定为 organize
- watermark-editor.js:943/1172/1174 ⚠ → `iconNode('warn')`（内联小图标）
- main.js:114 🔒 → `iconNode('security')`

### input.js
- :20 dz-ico 📄 → `iconNode('upload')`
- :45 ✕ 保留（非 emoji）

### 保留不换
✕（U+2715 关闭）、✓（U+2713 选中/SSIM 通过）、·（间隔点）、T（文字层字母）

## e2e 注意
e2e 断言不含 emoji（已验证）；gallery 截图须明暗两主题目检后方可集成。
