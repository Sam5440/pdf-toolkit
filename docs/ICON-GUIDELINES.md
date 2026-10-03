# SVG 图标绘制契约（ICON-GUIDELINES）

本项目共有**三套图标方案**，通过 `settings.iconSet` 在设置页切换：

| 方案 | iconSet 值 | 目录 / 位置 | 风格 |
|------|-----------|------------|------|
| 第一套 手绘线描 | `svg`（默认） | `src/assets/icons/*.svg` | 单色线描，`currentColor` 随主题 |
| 第二套 原版 emoji | `emoji` | `src/components/icons.js` 的 `EMOJI` 表 | 系统 emoji 字符 |
| 第三套 多彩手绘 | `color` | `src/assets/icons-color/*.svg` | 多彩线条手绘，固定调色板 |

图标由按语义族分批的 subagent 绘制（同一批次共用契约以保证家族一致），每个图标产出
**一个独立的 .svg 文件**。全部图标必须在同一视觉体系下协调一致。本契约是硬性要求，
验收时逐条检查。

## ⚠ 硬性细则：新功能图标三套齐备

**今后每新增一个功能（工具/壳层图标），必须同时补齐三套图标，缺一不可：**

1. `src/assets/icons/<id>.svg` — 单色线描版（本契约 §视觉规范）；
2. `src/assets/icons-color/<id>.svg` — 多彩手绘版（本契约 §多彩手绘方案，与单色版**同概念同构图**，仅换上色与手绘技法）；
3. `src/components/icons.js` 的 `EMOJI` 表新增 `<id>: '<emoji>'` 映射。

三套中任一套缺失，该功能图标视为未完成。验收标准：`bash scripts/check-icons.sh`（单色）
与 `bash scripts/check-icons.sh --color`（多彩）全部通过；两套 SVG 均通过画廊
明/暗双主题截图目检后方可集成（`node scripts/icon-gallery.mjs [--dir=src/assets/icons-color]`）。
纯别名工具（如 webpconvert → imgconvert，见 `ICON_ALIAS`）复用目标图标，不需新增文件，
但 emoji 表仍须有映射。

## 文件与命名

- 路径：`src/assets/icons/<id>.svg`（id 见任务指派，全小写，连字符分隔）
- 独立完整的 SVG 文件：带 `xmlns="http://www.w3.org/2000/svg"`，可被浏览器直接打开
- **只允许写你名下的这一个文件**；不得改动任何其他文件；不得运行 vite build

## 视觉规范（必须全部满足）

1. `viewBox="0 0 48 48"`，`width`/`height` 属性省略（由 CSS 控制）。
2. 线条风格：`fill="none"` + `stroke="currentColor"` + `stroke-width="2.5"` +
   `stroke-linecap="round"` + `stroke-linejoin="round"`（根 `<svg>` 上统一声明）。
3. 单色：全部用 `currentColor`（随主题变色，深浅色模式都需清晰）。可用
   `fill="currentColor"` 的小实心点缀（≤2 处，如圆点），但主体必须是线描。
4. 语义：图形必须贴合工具功能，一眼可辨；禁止使用文字/字母/数字作为图形元素
   （OCR 等也不要用字母，用抽象图形表达"识别"）。
5. 构图：内容绘制在 6px 内边距内（即 6,6 → 42,42 安全区）；视觉重心居中；
   禁止贴边或出界。
6. 简洁：元素数量 ≤ 7 个基本图元（rect/circle/path/line）；删除一切装饰性细节，
   保证 20px 显示尺寸下仍可辨认（心里做个"缩小测试"）。
7. 禁止：`<style>`、CSS 动画、渐变、滤镜、外部引用、`<text>`、emoji 字符。
8. PDF 语境约定：页面用圆角矩形（rect rx=3，竖版比例约 24×32）表达；多页用
   错位叠放表达。若工具语义与"页面"相关，优先用此母题保持家族感。

## 自检（完成后必须执行并在报告贴输出）

```bash
python3 -c "import xml.etree.ElementTree as ET; ET.parse('src/assets/icons/<id>.svg'); print('XML OK')"
grep -c currentColor src/assets/icons/<id>.svg   # 应 ≥1
grep -cE "<text|<style|url\(|gradient" src/assets/icons/<id>.svg  # 应为 0
```

## 报告格式

- 图标概念：一句话（画了什么、为何贴合该功能）
- 自检输出
- 你对该图标的独特的辨识点（验收人据此判断是否"贴合功能"）

## 多彩手绘方案规范（第三套，`src/assets/icons-color/`）

与第一套同概念、同构图 DNA（母题不变：竖版圆角页面约 24×32、多页错位叠放），
但用固定调色板上色 + 手绘技法。除下述差异外，§视觉规范 的构图/安全区/简洁性/
禁止项（除 `currentColor` 外）全部适用。

### 根元素与颜色

1. 根元素：`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none"
   stroke-linecap="round" stroke-linejoin="round">`——根上**不写 stroke**，每个图元
   自带 `stroke="#色号"`；**禁止 `currentColor`**（本方案刻意用固定色，明暗两主题
   通用，调色板已按双主题对比度挑选）。
2. **统一调色板（只允许这些色值，逐字符一致）**：

   | 语义 | 色值 |
   |------|------|
   | 文档页面主体（蓝） | `#3B82F6` |
   | 查看/浏览/信息（天蓝） | `#0EA5E9` |
   | 表格/数据/转换（青） | `#14B8A6` |
   | 成功/输出/自然（绿） | `#22C55E` |
   | 警示/高亮/光源（琥珀） | `#F59E0B` |
   | 动作箭头/方向/能量（橙） | `#F97316` |
   | 删除/危险/编辑强调（红） | `#EF4444` |
   | 安全/加密/创意（紫） | `#8B5CF6` |
   | 图像/照片/装饰（粉） | `#EC4899` |
   | 中性辅助（石板灰，只做内容线/细部） | `#64748B` |

3. 每个图标 2–4 种颜色：主形体用 1 个主色（按语义选主色），辅以 1–2 个辅色，
   `#64748B` 占比要小（内容线、次级细节）。同族图标主色必须一致
   （页面/文档=蓝，箭头动作=橙，成功输出=绿，安全=紫，图像=粉/青，警示=琥珀）。

### 手绘技法（必须全部满足前两条）

1. **直线改轻弯**：长直线用 `Q` 轻弯 0.5–1px（如 `M18 16 Q24 15 30 16.4`）；
2. **圆角矩形改 path**：四角圆滑、边微鼓（弓 ≤0.8px），例：
   `M15 9.3 C20 8.6 28 8.8 33 9.2 C33.8 16 33.6 31 33.2 37.4 C28 38 20 37.9 15.2 37.5 C14.5 30 14.7 16 15 9.3 Z`；
3. （可选加分）1 处交叉短线出头 ≤1.5px，或关键边旁一条 3–6px 平行复描短线（铅笔感）；
4. **整体微倾**：全部内容包在 `<g transform="rotate(-2 24 24)">` 内（所有图标统一
   -2°，形成"手贴贴纸"的家族感）；
5. `stroke-width="2.5"` 统一；实心点缀（无 stroke 的 `fill` 小圆点）≤2 处；
6. 图元 ≤10（比单色版多出的额度用于手绘复描线）；缩小到 20px 仍可辨认；
7. 禁止：`<text>`、`<style>`、渐变、滤镜、外部引用、emoji 字符、`currentColor`。

### 自检（多彩版）

```bash
python3 -c "import xml.etree.ElementTree as ET; ET.parse('src/assets/icons-color/<id>.svg'); print('XML OK')"
grep -c currentColor src/assets/icons-color/<id>.svg   # 应为 0
grep -cE "<text|<style|url\(|[Gg]radient|filter" src/assets/icons-color/<id>.svg  # 应为 0
bash scripts/check-icons.sh --color <id>               # 应 ✓（含调色板色值白名单校验）
```
