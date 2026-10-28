import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "陪玩",
  "purpose": "识别前台游戏并按配置观察画面或提醒。",
  "setup": "先配置游戏库并保持主动搭话和看图关闭；确认 Windows 窗口识别后再开启需要的功能。",
  "firstUse": "请助手用 gaming_windows 查看窗口、gaming_library 管理游戏库，再用 gaming_now 核对识别。",
  "troubleshoot": "误认先查游戏库；自动看图时把游戏放前台。需要钉窗口可用 gaming_watch_window，target 填进程、title 填标题关键字，两项同时填写时都要匹配；先恢复最小化窗口。后台窗口只尝试读取窗口本身，不能用桌面画面代替；多帧抓图失败不会重复单帧。画面分析另需视觉端点与部署侧凭据，启用会产生模型调用。",
  "remount": [
    "pollMs"
  ]
}
