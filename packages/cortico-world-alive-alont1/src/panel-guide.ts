import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "能动性",
  "purpose": "记录想做的事，按时间和配额提醒，并提供桌面及用量查看。",
  "setup": "启用后先设静默时段、每日提醒上限和控制台地址。自己的时间只在连续空闲达到配置窗口后推送；旧记忆目录配置已弃用。",
  "firstUse": "请助手用 alive_want 记下一件事，alive_list 核对，到完成时用 alive_done；alive_cost 查看用量。",
  "troubleshoot": "不提醒时检查到期时间、静默时段和每日配额；用量为空先查宿主账本。"
}
