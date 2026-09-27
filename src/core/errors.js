// 统一错误码与用户文案（worker 与主线程共用）

export const ERR = {
  ERR_BAD_PDF: '文件不是有效的 PDF 或已损坏',
  ERR_ENCRYPTED: '文件已加密，请先输入密码解锁',
  ERR_WRONG_PASSWORD: '密码错误或无法解锁',
  ERR_BAD_ARGS: '参数无效',
  ERR_RANGE: '页范围超出文档页数',
  ERR_CANCELLED: '已取消',
  ERR_LIMIT: '超出处理限制',
  ERR_ENGINE: '处理引擎错误',
  ERR_UNSUPPORTED: '当前浏览器不支持此功能',
  ERR_OOM: '内存不足，请尝试更小的文件或更低的分辨率',
  ERR_NO_INPUT: '未选择输入文件',
  ERR_FONT: '字体加载失败',
};

export function toolkitError(code, detail) {
  const e = new Error(detail ? `${ERR[code] || code}：${detail}` : (ERR[code] || code));
  e.code = code;
  return e;
}
