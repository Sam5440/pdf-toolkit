# SVG 图标绘制契约（ICON-GUIDELINES）

每个图标由一名独立 subagent 绘制，产出**一个独立的 .svg 文件**。全部图标必须在
同一视觉体系下协调一致。本契约是硬性要求，验收时逐条检查。

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
