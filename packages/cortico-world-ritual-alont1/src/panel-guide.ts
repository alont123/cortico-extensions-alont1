import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "仪式感",
  "purpose": "按本地时间提醒早安、晚安，并记住纪念日。",
  "setup": "启用，核对部署时区并填写 24 小时制 HH:MM 时间。",
  "firstUse": "早晚时间在配置里填写；请助手用 ritual_set 记录月-日和纪念日名称，再用 ritual_list 查看。",
  "troubleshoot": "时间格式错误或时区不同会影响触发；检查间隔内有少量延迟属于正常。",
  "fields": {
    "morningAt": {
      "title": "早安时间（HH:MM）"
    },
    "nightAt": {
      "title": "晚安时间（HH:MM）"
    }
  }
}
