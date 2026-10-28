import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "情绪天气",
  "purpose": "根据前台程序和键鼠空闲时长提供粗略活动状态。",
  "setup": "在 Windows 桌面会话中启用，设置检查与事件最小间隔。",
  "firstUse": "请助手用 mood_now 查看当前状态，切换程序后等待下一次检查。",
  "troubleshoot": "系统取不到窗口时会无结果；推测的忙碌或游戏状态不代表人的真实心情。",
  "fields": {
    "tickSec": {
      "type": "integer",
      "minimum": 30,
      "title": "检查间隔（秒）"
    },
    "minEventGapSec": {
      "type": "integer",
      "minimum": 60,
      "title": "事件最小间隔（秒）"
    }
  }
}
