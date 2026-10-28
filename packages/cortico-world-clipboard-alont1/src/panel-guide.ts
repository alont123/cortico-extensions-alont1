import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "剪贴板",
  "purpose": "按需读取当前系统剪贴板中的文字。",
  "setup": "在可访问本机桌面的环境启用，设置返回文字长度。",
  "firstUse": "先复制一段非敏感文字，再让助手用 clipboard_read 读取。",
  "troubleshoot": "没有文字时检查是否复制了图片、远程会话或系统权限是否影响剪贴板。",
  "fields": {
    "maxChars": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100000,
      "title": "最多读取字数"
    }
  }
}
