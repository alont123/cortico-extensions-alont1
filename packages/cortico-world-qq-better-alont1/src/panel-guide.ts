import type { PanelGuide } from './panel-runtime.ts'
export const PANEL_GUIDE: PanelGuide = {
  "title": "QQ 群聊",
  "purpose": "连接本实例的 OneBot/NapCat，收发消息并维护监听名单。",
  "setup": "先在 NapCat 登录账号，按正向或反向模式填写一致的连接地址与端口；凭据只在部署侧维护。状态和默认图库位于 dataDir/qqbot；旧共享图库需明确配置或手动迁移。",
  "firstUse": "先检查 NapCat 连接与身份，再在监听名单页核对会话，收到一条测试消息后让助手用 qqbot_conversations 查看。私聊默认合并发送；群聊达到 120 字符才允许拆句。单次默认最多 2 条，可在拆条设置中调整。",
  "omit": [
    "memoryDir",
    "emotion",
    "proactive.systemPrompt",
    "proactive.endpoint",
    "proactive.apiKeySecret",
    "proactive.model",
    "proactive.warmupMin",
    "proactive.warmupChance",
    "proactive.unrepliedThreshold",
    "proactive.silentHours",
    "proactive.dedupWindow",
    "proactive.topicSimilarity",
    "qzone.systemPrompt",
    "qzone.endpoint",
    "qzone.apiKeySecret",
    "qzone.model",
    "qzone.imageMode",
    "qzone.autoReplyComments"
  ],
  "troubleshoot": "回执会分别列出已受理、结果未确认和未尝试条数；已受理不代表对方已读。部分失败会停止后续条目，请先核对结果，勿整条重发。超出条数上限会整次拒绝，不截断正文。候选调度只提供事件，不会替 Persona 发言；空间发布必须显式给正文和配图。旧独立人格模型和自动情绪配置已停用。反向等待连接时检查地址、端口与 Token；名单支持逗号/空格分隔账号，私聊星号代表全监听；群管必须单独授权。"
}
