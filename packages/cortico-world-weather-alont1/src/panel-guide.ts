import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "天气",
  "purpose": "按需查询当前天气并给出简单穿衣与带伞建议。",
  "setup": "启用并填写默认城市；临时提问也可指定别的城市。",
  "firstUse": "在对话中说想查哪个城市，让助手调用 weather_now。",
  "troubleshoot": "无结果先检查网络和城市拼写；扩展启动不代表天气站已连通。"
}
