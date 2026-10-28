import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "QQ 空间",
  "purpose": "通过本实例 NapCat 发布、查看配额和删除说说。",
  "setup": "填写本实例 HTTP 端点、可见范围、每日上限和静默时段。配图库默认 dataDir/qzone/stickers，可独立设置 stickerDir，不要求 QQ 扩展。",
  "firstUse": "先让助手用 qzone_status 核对，再明确要求 qzone_post 发布测试内容，qzone_delete 删除指定说说。",
  "troubleshoot": "账号不对先核查端点；发布失败查看服务登录和接口支持，发出的内容会真实对外可见。"
}
