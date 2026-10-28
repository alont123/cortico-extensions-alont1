import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "作品页",
  "purpose": "保存作品条目并生成本地作品页。",
  "setup": "启用，确认部署数据与输出目录可写。",
  "firstUse": "请助手用 works_add 保存一件作品，works_list 核对后再用 works_page 生成页面。",
  "troubleshoot": "生成页面不等于发布到互联网；写盘失败先排查目录权限，损坏数据需恢复后再继续。"
}
