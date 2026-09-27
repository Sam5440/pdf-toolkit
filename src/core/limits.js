// 设置 → 引擎 limits 同步（渲染像素上限等）
import { getSettings } from './settings.js';

export function setLimitsFromSettings() {
  // limits 由 engine.js 在每次 op 时从 settings 读取；此处预留显式同步入口
  return { ...getSettings() };
}
