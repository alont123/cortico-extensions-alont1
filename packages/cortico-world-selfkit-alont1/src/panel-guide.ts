import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "自我运维",
  "purpose": "只读查看本实例状态、近期日志和扩展挂载情况。",
  "setup": "填写本实例控制台端口，启用并设置日志返回行数。",
  "firstUse": "请助手先用 self_status 查看状态，再用 self_worlds 看扩展、self_log 读近期日志。",
  "troubleshoot": "连接失败先查端口和控制台是否运行；本工具不负责自动重启部署。",
  "fields": {
    "consolePort": {
      "type": "integer",
      "minimum": 1,
      "maximum": 65535
    },
    "logLines": {
      "type": "integer",
      "minimum": 5,
      "maximum": 100
    }
  }
}
