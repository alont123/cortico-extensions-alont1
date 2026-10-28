import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "手机模拟器",
  "purpose": "启动并操作已安装的 MuMu 模拟器实例。",
  "setup": "填写 MuMu 安装目录和实例序号，确认该实例可正常启动，再启用扩展。",
  "firstUse": "请助手先用 phone_status 检查、phone_launch 启动、phone_screenshot 看屏幕，再进行简单点击。",
  "troubleshoot": "找不到实例检查安装目录与序号；启动较慢时调整等待上限，关闭用 phone_close。",
  "fields": {
    "mumuDir": {
      "title": "MuMu 安装目录",
      "x-path": {
        "kind": "directory"
      }
    },
    "vmIndex": {
      "type": "integer",
      "minimum": 0,
      "title": "模拟器实例序号"
    },
    "bootTimeoutSec": {
      "type": "integer",
      "minimum": 30,
      "maximum": 600,
      "title": "启动等待上限（秒）"
    }
  }
}
