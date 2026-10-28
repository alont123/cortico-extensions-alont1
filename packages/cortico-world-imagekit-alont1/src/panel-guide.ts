import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "图片与头像",
  "purpose": "搜索、下载和查看图片，并通过对应服务设置头像。",
  "setup": "启用并配置本实例的 HTTP 服务地址，检查文件大小和搜索结果上限。",
  "firstUse": "让助手先用 image_search 找图，再用 image_download 下载、image_list 核对。需要换头像时明确提出 avatar_set。",
  "troubleshoot": "下载失败检查链接和大小；换头像需要服务端已登录且具备相应接口。",
  "fields": {
    "maxResults": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
    },
    "maxBytes": {
      "type": "integer",
      "minimum": 100000,
      "maximum": 20000000
    }
  }
}
