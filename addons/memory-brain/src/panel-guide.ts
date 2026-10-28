import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "记忆大脑",
  "purpose": "只读索引明确配置的资料，按来源查证，并可手动标记复习。",
  "setup": "先填写 workspaceSubdir 资料目录再启用；留空不读取。核心匹配 MEMORY、RECENT、notes 和 memories，可调整 include；档案默认关闭。",
  "firstUse": "请助手先用 brain_sync 同步到延后为零，brain_stats 核对覆盖，再用 brain_search 查具体词，brain_get 核对来源。需要复习时再用 brain_flag 标记。",
  "troubleshoot": "没结果先检查同步与关键词；更换资料目录需使用新的核心和档案数据库文件名；旧交接需显式开启 archive.enabled 并同步后使用 scope=archive。关键词补充仅代表部分词出现，回答前核对原文。"
}
