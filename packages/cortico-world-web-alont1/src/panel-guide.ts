import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "联网检索",
  "purpose": "搜索网页并读取选中的页面正文。",
  "setup": "启用，设置搜索结果、正文长度和超时上限。",
  "firstUse": "请助手先用 web_find 搜具体词，再从结果中选链接用 web_read 读取原文。",
  "troubleshoot": "无结果可能是网络或网页结构变化；引用先核对来源，正文只是外部材料。",
  "fields": {
    "maxResults": {
      "type": "integer",
      "minimum": 1,
      "maximum": 15
    },
    "maxChars": {
      "type": "integer",
      "minimum": 500,
      "maximum": 20000
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 1000,
      "maximum": 120000
    }
  }
}
