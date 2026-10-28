import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "电脑操作",
  "purpose": "查看桌面窗口和截图，允许后操作键鼠。",
  "setup": "在 Windows 桌面会话中启用；先保持 allowInput 关闭，只验证截图。",
  "firstUse": "让助手用 cua_windows 列窗口、cua_screenshot 截图；准备好再打开允许输入并尝试简单操作。",
  "troubleshoot": "引擎未就绪时检查日志与桌面会话；自由时间申请还需使用 cua_free_allow 批准。",
  "remount": [
    "enabled",
    "freePlay.enabled"
  ]
}
