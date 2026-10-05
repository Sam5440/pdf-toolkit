# AGENTS.md — AI 代理开发指南

本文件面向在本仓库工作的 AI 编码代理（ZCode / Claude / Codex 等），浓缩架构要点、
开发契约与血泪踩坑。**动手前先读完本文件**；引擎 op 协议细节见
[docs/CONTRACTS.md](docs/CONTRACTS.md)，图标规范见
[docs/ICON-GUIDELINES.md](docs/ICON-GUIDELINES.md)，测试分层见
[tests/README.md](tests/README.md)。

## 项目是什么

纯静态浏览器端 PDF 工具箱（Vite + 原生 ES modules，**无框架**）：15 核心工具 + 49 扩展
工具，全部处理在浏览器内 Web Worker + WASM（pdf-lib / pdf.js / mupdf / Tesseract.js /
pandoc / typst）完成，**文件字节绝不发送网络**。线上 https://pdftools.isam.top/（Vercel，
push 即自动部署，1-2 分钟生效）。

## 硬性红线（违约即返工）

1. **任何"上传到服务器"的实现都是违约**。后台只服务静态文件；新增能力必须本地可完成。
2. **密码不落盘**：不写 localStorage / IndexedDB / 历史 / URL；历史保存前剔除含
   `pass/password/secret/token` 字样的选项键（`more/common.js sanitizeOptions` 已做，勿绕过）。
3. **用户内容禁止 innerHTML 注入**：用户值必须走 `esc()`（core/format.js）或 `textContent`；
   只有构建期静态模板可用 innerHTML。
4. **e2e 上传必须走真实 filechooser**，禁止 DOM 注入伪造文件。
5. **缺测试不计完成**：新功能/修 bug 至少补对应层级的测试（见「测试要求」）。
6. **用户未明确要求时不要 commit / push**（push 即上线）。提交身份是仓库级
   `PDF Toolkit <pdf-toolkit@localhost>`，勿用个人身份；commit message 用中文
   conventional commits（`feat(webpage): …`）。

## 常用命令

```bash
npx vite build                      # 构建 → dist/（改完代码必须跑，见下）
python3 scripts/serve.py dist 8137  # 本地静态服务（用户的浏览器入口就是 8137）
npx vitest run                      # 单元测试（node 环境，无 DOM）
npx playwright test                 # e2e（webServer 自带 build+serve 8137，reuseExistingServer）
python3 -m pytest tests/verify tests/legacy -q   # Python 独立校验（112 条）
python3 scripts/build_fixtures.py   # 生成 e2e 夹具（tests/fixtures/out/）
node scripts/fetch-engines.mjs      # 重建 public/engines/（pandoc 58MB + typst 28MB，不进 git）
node scripts/app-screenshots.mjs    # 重拍 README 截图（docs/screenshots/）
bash scripts/check-icons.sh [--color] <id>   # 图标合规检查
```

## 铁律：改完 src 必须重建 dist

用户的浏览器入口是 **8137（serve dist/）**，只改 src 不 build 用户什么都看不到。
且 e2e 的 webServer `reuseExistingServer` 会复用已在跑的 8137 旧服务器——**先
`npx vite build` 再跑 e2e，否则测的是旧构建**（曾两次因此出假阳性）。服务进程被系统
回收时重启：`nohup python3 scripts/serve.py dist 8137`。

## 架构速览

```
index.html          内联开场动画（boot-splash，bundle 加载前即播；motion=false → boot-static）
src/main.js         应用壳：hash 路由(#/tool/<id>、#/more、#/history)、侧边栏/顶栏、
                    首页(收藏制)、设置弹窗(含引擎状态面板)、splash 退场
src/core/
  engine.js         引擎池（Worker 池、op 调度、ensureDoc 记忆化、驱逐重试、
                    转发 worker 引擎状态上报）
  engine-worker.js  全部 PDF op 实现；懒加载 pdfjs/mupdf/tesseract（notifyEngine 上报状态）
  engine-more.js    扩展 op；与 engine-worker 循环引用（只在函数体内互访，顶层会 TDZ 崩）
  md*.js            Markdown→PDF/Word 链路：mdrender(块模型) mddocx(OOXML) mdpandoc(pandoc
                    wasm) mdtypst(typst wasm) mdhtml(即时预览) mdhl(语法高亮)
  wasm-registry.js  引擎加载状态中心（纯状态；wasm-probes.js 装配探测闭包，设置面板消费）
  settings.js       localStorage `pdftoolkit.settings.v1`（主题/accent/radius/motion/iconSet/上限…）
  favorites.js      收藏（localStorage；defaultFav 标记 + MIGRATIONS 迁移键）
  history.js        IndexedDB 历史（配额管理）
src/components/     ui.js(shadcn 风格基件) shadcn.js(Select/Slider/Color 全局增强，MutationObserver)
                    search.js(⌘K 命令面板) tray.js(右侧暂存区，全局单例 DOM) input.js icons.js
src/tools/          15 核心工具 + registry.js；tools/more/ 49 扩展工具 + common.js 公共件
```

## 开发契约要点

- **新工具**：`src/tools/` 下自注册 `registerTool({id,name,icon,group,desc,accepts,render})`
  （协议见 CONTRACTS.md §4）；同时补 `search-data.js` 的介绍与关键词（有单测锁覆盖）、
  收藏默认值视需求设 `defaultFav`。
- **新图标必须三套齐备**（硬性）：`icons/<id>.svg` + `icons-color/<id>.svg` +
  `icons.js` EMOJI 表；`check-icons.sh` 单色/彩色全绿才算完成。
- **新 UI 控件的可达名必须全库 grep 既有 spec**：Playwright `getByRole name` 是
  **子串匹配**，极易撞车（例：「清空暂存区」会撞「清空」；顶栏按钮要避开工具页同名按钮）。
- **移动端隐藏按钮文字时必须保留可访问名**：顶栏按钮文字包在 `.btn-label` span 里被
  CSS 隐藏，**必须同时 `aria-label`**，否则可访问名消失、e2e 直接挂（真实踩过）。
- **新增懒加载引擎要接状态上报**：加载点调 `setEngineStatus(id,status,detail)`（Worker 内
  用 `notifyEngine` postMessage，engine.js 已转发）；设置面板才能展示。探测 op 走
  `engine.warm`。
- **首页收藏计数是锁定的**：favorites.test 断言 17 默认收藏 / 49 扩展工具；动收藏逻辑
  先看该测试与 MIGRATIONS 迁移设计（老用户偏好不能丢）。

## e2e 契约要点

- `openTool(page, toolId)` helper = `page.goto('/')` + 点侧边栏链接（**整页重载**，内存态
  断言要用 hash 点击而非 goto）。
- 上传：`.dropzone` click + `waitForEvent('filechooser')` + `setFiles`；下载：
  `waitForEvent('download')` → `saveAs('tests/e2e/.artifacts/')`。
- 每工具至少：1 成功链路（真实下载）+ 1 参数错误链路（无产物有提示）+ UI 状态断言；
  内容级校验归 pytest verify（pypdf/fitz 交叉验证，命名 `<tool>-<case>.pdf`）。
- 夹具由 `scripts/build_fixtures.py` 生成，spec 用 `ensureFixtures()`。

## 踩坑清单（每条都真实付出过代价）

**环境/构建**
- `core/`、`components/` 模块**顶层禁止触碰 `document`/`window`**（vitest node 环境无 DOM，
  import 链经 registry 会炸全套单测）；`document.baseURI` 同禁（mdtypst 用惰性函数）。
- dev server(5173) 下 engine-worker ↔ engine-more 循环引用 TDZ 崩——**测引擎一律走
  prod build**，勿在 dev 模式排查引擎问题。
- vite build 先清空 dist，数秒窗口内 wasm/资产短暂 404——fetch 必须带重试（mdpandoc/
  mdtypst 已实现 404 重试，勿删）。
- `public/` 里 fonts/tessdata/pdfjs（约 40MB）**在 git**；`public/engines/` **不在**，
  新克隆必须 `fetch-engines.mjs`，否则仅 md2pdf 的 Typst/Pandoc 404。

**引擎/pdf.js**
- pdf-lib `embedFont(subset:true)` 对 CJK 产损坏字形（干净 fontTools 子集也坏）——
  **文本型 PDF 唯一可靠路径 = fontTools 预子集字库 + `subset:false` 全量嵌入**
  （`public/fonts/text/NotoSansSC-*-Text.ttf`）。字库重建链：`build_fonts.sh` →
  `build_text_fonts.py` 都要跑（中间产物曾缺字符区）。
- Worker 内 pdf.js 必须 `useWorkerFetch:true` + `CanvasFactory: OffscreenCanvasFactory` +
  `FilterFactory: NoDomFilterFactory`（worker 无 document）；`getDocument` 咽喉点唯一
  （pdfjsOpen），新增渲染路径必须复用它。`getDocument({data})` 会转移 buffer → 传
  `bytes.slice()`。
- mupdf redact：`loadPage(pageNo)`（非 getPage）+ `createAnnotation('Redact')` +
  **视觉左上坐标直传**（visualToUser 反而颠倒）；加密密码含 `,`/`=` 被引擎拒绝（UI 有提示）。
- typst preamble 用 `math.equation`（typst 0.14 命名；`math.formula` 是 0.15 的，会炸）；
  pandoc fragment 输出的 `#horizontalrule` 必须在 preamble 自定义（官方模板定义已内置）。
- OCR 词坐标在 `w0.bbox`（tesseract v7 嵌套）；tessdata 本地未压缩，worker 须 `gzip:false`。

**UI/样式**
- `animation-fill-mode: both` 的 to 帧会**永久钉死 transform**，杀掉 hover 效果——入场
  动画一律 `backwards`（例：首页卡片交错入场）。
- 动效双通道：设置 `motion:false` → `html[data-motion=off]`（全局杀动画）+
  `prefers-reduced-motion` 媒体查询，新增动画两者都要覆盖；开场动画另有 boot-static 类。
- 暂存区 tray 是全局单例 DOM（renderApp 重建时塞回），订阅只建一次；新弹层/全局控件
  参照此模式防泄漏。抽屉态 `body.tray-open`（≤1020px），收起 `body.tray-collapsed`（持久）。
- 开场 splash 在 `body` 下（**不在 #app 内**，renderApp 会清空 #app）；main.js 就绪后
  `dismissBootSplash()` 淡出移除。

**测试/验收**
- e2e 偶发 flake（共享 8137 服务器/端口竞争），复跑单 spec 排除；但**先确认 dist 是新的**。
- 视觉验收：本地 Playwright 截图（手机仿真 `viewport:375×812, isMobile, hasTouch`）+
  人工目检；README 截图用 `node scripts/app-screenshots.mjs`（脚本已适配开场动画等待）。
- pytest verify 是独立引擎交叉验证，**不许用浏览器产物自证**。

## 测试要求（完成的定义）

改动合并前三套件全绿：`npx vitest run`（168）+ `npx playwright test`（151）+
`python3 -m pytest tests/verify tests/legacy -q`（112）。新功能随代码补测试：
纯逻辑 → vitest；用户链路 → e2e；产物正确性 → pytest verify。修 bug 先写红测试再修。
