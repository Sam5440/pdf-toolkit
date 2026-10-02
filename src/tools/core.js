// 工具注册核心：工具模块在自身模块体中调用 registerTool 完成自注册
export const TOOLS = [];

export const GROUPS = [
  // 核心功能分类（首页默认收藏所在）
  { id: 'optimize', name: '优化' },
  { id: 'pages', name: '页面' },
  { id: 'content', name: '内容' },
  { id: 'convert', name: '转换' },
  { id: 'security', name: '安全' },
  { id: 'check', name: '检查' },
  // 「更多」页专用功能分类（hiddenOnHome：默认不收藏、不在首页显示；
  // 专项页 #/more 按这些分类分区展示，收藏后其分类分区会出现在首页）
  { id: 'm-page', name: '页面处理', hiddenOnHome: true },
  { id: 'm-edit', name: '编辑与表单', hiddenOnHome: true },
  { id: 'm-secure', name: '安全与隐私', hiddenOnHome: true },
  { id: 'm-fix', name: '优化与修复', hiddenOnHome: true },
  { id: 'm-topdf', name: '转换为 PDF', hiddenOnHome: true },
  { id: 'm-frompdf', name: 'PDF 转格式', hiddenOnHome: true },
  { id: 'm-img', name: '图片工具', hiddenOnHome: true },
  { id: 'm-view', name: '查看与检索', hiddenOnHome: true },
  { id: 'm-util', name: '实用工具', hiddenOnHome: true },
];

export function registerTool(tool) {
  if (!tool?.id) throw new Error('工具缺少 id');
  if (TOOLS.some((t) => t.id === tool.id)) {
    // 后注册者覆盖（便于占位被实现替换）
    const i = TOOLS.findIndex((t) => t.id === tool.id);
    TOOLS[i] = tool;
    return;
  }
  TOOLS.push(tool);
}

export function getTool(id) {
  return TOOLS.find((t) => t.id === id) || null;
}
