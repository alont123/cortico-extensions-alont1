import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "记忆检索",
  "purpose": "只读检索明确配置的资料目录，返回来源和行号。",
  "setup": "填写 sourceDir（相对部署目录或绝对路径）后启用；留空不读取。设置结果数、文件数量和单文件大小上限。",
  "firstUse": "请助手先用 mem_stats 看覆盖，再用 mem_search 搜一个已知的具体关键词。",
  "troubleshoot": "缺资料先查 sourceDir；链接、隐藏目录、node_modules 和 blobs 不扫描。mem_stats 可立即刷新文件覆盖；自然问句仍是词面检索。",
  "remount": [
    "sourceDir"
  ],
  "fields": {
    "sourceDir": {
      "title": "资料目录",
      "description": "明确指定只读资料根目录；留空不读取。",
      "x-path": {
        "kind": "directory"
      }
    },
    "maxResults": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
    },
    "maxFileMB": {
      "minimum": 0.5,
      "maximum": 20,
      "multipleOf": 0.1
    },
    "maxFiles": {
      "type": "integer",
      "minimum": 50,
      "maximum": 3000
    }
  }
}
