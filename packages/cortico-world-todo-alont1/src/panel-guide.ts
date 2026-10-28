import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "任务板",
  "purpose": "记录答应的事、可选到期说明和完成状态。",
  "setup": "启用，确认部署数据目录可写。",
  "firstUse": "请助手用 todo_add 记一条任务、todo_list 查看，再用 todo_done 标记完成；记错用 todo_remove 删除。",
  "troubleshoot": "写盘失败不会回报保存成功；到期文字是任务说明，不等于自动闹钟提醒。"
}
