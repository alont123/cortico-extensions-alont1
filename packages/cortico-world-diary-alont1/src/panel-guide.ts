import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "截图日记",
  "purpose": "将当前屏幕截图和一句备注按日期存放。",
  "setup": "启用并设置可写的输出目录、每日截图上限和正确时区。",
  "firstUse": "请助手用 diary_snap 写一句今天的话并截图，再用 diary_today 或 diary_list 查看。",
  "troubleshoot": "截图失败检查桌面权限；达到每日上限后会停止新增。",
  "fields": {
    "maxPerDay": {
      "type": "integer",
      "minimum": 1,
      "title": "每天最多截图数"
    },
    "outDir": {
      "x-path": {
        "kind": "directory"
      }
    }
  }
}
