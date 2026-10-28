import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "下载记录",
  "purpose": "观察指定下载目录中新出现的文件。",
  "setup": "填写可读的下载目录并启用，设置扫描间隔。",
  "firstUse": "把一份测试文件放进目录，稍候让助手用 downloads_recent 查看、downloads_stats 核对数量。",
  "troubleshoot": "空结果先核对扫描目录；扫描只看配置的目录，不代表浏览器下载任务已完成。",
  "fields": {
    "dir": {
      "x-path": {
        "kind": "directory"
      }
    },
    "scanSec": {
      "type": "integer",
      "minimum": 15,
      "title": "扫描间隔（秒）"
    }
  }
}
