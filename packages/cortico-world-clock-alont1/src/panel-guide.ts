import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "时间感",
  "purpose": "告诉助手当前钟点、星期和时段，并可按配置报时。",
  "setup": "【与人味重复，不要同时启用】已启用人味（humanlike）时，请停用本扩展；两者择一。启用扩展，确认部署时区正确；选择报时模式与最小间隔。",
  "firstUse": "问现在几点，让助手调用 clock_now；再观察配置的时段变化是否提醒。",
  "troubleshoot": "时间不对先修部署时区；静默模式和间隔可能让报时暂不出现。"
}
