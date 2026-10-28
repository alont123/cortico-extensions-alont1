import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "相册",
  "purpose": "按人物和时间寻找聊天中保存的图片，并给图片写备注。",
  "setup": "启用扩展，确认当前部署的消息账本与图片文件可读。",
  "firstUse": "让助手先用 album_scan 补索引，再用 album_list 筛选、album_view 查看、album_note 备注。",
  "troubleshoot": "空相册先检查聊天中是否确有图片；缺失图片无法靠重新扫描还原。"
}
