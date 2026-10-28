import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "玩具世界",
  "purpose": "运行短小 JavaScript 片段并查看保存的产物。",
  "setup": "启用并设置单次执行超时。",
  "firstUse": "请助手用 play_run 运行一段简单计算，再用 play_list 查看产物。",
  "troubleshoot": "超时先缩短代码；动态代码生成和部分系统能力被禁用，子进程不代表完整恶意代码隔离。",
  "fields": {
    "timeoutSec": {
      "minimum": 1,
      "maximum": 30,
      "title": "单次执行超时（秒）"
    }
  }
}
