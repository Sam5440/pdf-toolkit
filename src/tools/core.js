// 工具注册核心：工具模块在自身模块体中调用 registerTool 完成自注册
export const TOOLS = [];

export const GROUPS = [
  { id: 'optimize', name: '优化' },
  { id: 'pages', name: '页面' },
  { id: 'content', name: '内容' },
  { id: 'convert', name: '转换' },
  { id: 'security', name: '安全' },
  { id: 'check', name: '检查' },
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
