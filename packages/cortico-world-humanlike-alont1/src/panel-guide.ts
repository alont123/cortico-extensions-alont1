import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "人味",
  "purpose": "把交情、学习、作息、时间、共同经历、惦记和只读观察合在一个扩展。",
  "setup": "【互斥使用提示】人味已内置好感度（affinity）、学习（learn）、作息（life）、时间感（clock）、相处（together）、心事（mind）、现实感知（real）。不要同时启用这七个对应的独立扩展（cortico-world-<名称>-alont1）。人味只有宿主扩展卡片上的一个总开关，内置模块随总开关一起运行。只开总闸，先调主人信息、作息和提醒上限。旧版数据迁移默认关闭，仅确认旧文件属于早期人味且备份后开启；完成后关闭。",
  "firstUse": "先查看已有状态。新消息头可提供时间；需要精确当前钟点时再用 humanlike_clock_now。想安排提醒时，用 humanlike_mind_want 记一件事。",
  "troubleshoot": "模块没有记录不代表离线；提醒要核对配额与静默时段。只读观察依赖当前部署的账本和桌面。",
  "omit": [
    "affinity.enabled",
    "learn.enabled",
    "life.enabled",
    "clock.enabled",
    "together.enabled",
    "mind.enabled",
    "real.enabled"
  ]
}
