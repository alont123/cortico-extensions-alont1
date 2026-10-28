import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "记忆体检",
  "purpose": "只读统计明确配置资料目录的文件体积、增长和重复片段。",
  "setup": "填写 sourceDir 后启用；旧显式 memoryDir 仍兼容。residentFilesJson 可指定需单独统计的常驻文件，默认不推断。",
  "firstUse": "让助手用 memory_check 体检，再用 memory_find 定位某个关键词；整理需另行明确操作。",
  "troubleshoot": "目录或常驻文件列表变更后重新挂载。扩展不读取 Persona 的路径配置，也不压缩、删除来源文件。",
  "remount": [
    "memoryDir",
    "sourceDir",
    "residentFilesJson"
  ]
}
