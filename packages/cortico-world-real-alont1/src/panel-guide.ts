import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "只读观察",
  "purpose": "查看桌面、账本花销、提示词前缀与当前配置摘要。",
  "setup": "【与人味重复，不要同时启用】已启用人味（humanlike）时，请停用本扩展；两者择一。启用，确认本实例控制台端口与账本位置。",
  "firstUse": "请助手先用 real_cost 看用量、real_prefix 查前缀，再按需用 real_desk 看桌面。",
  "troubleshoot": "前缀读不到检查控制台端口；没有账本时无法统计花销；价格表仅用于估算。",
  "remount": [
    "consolePort"
  ]
}
