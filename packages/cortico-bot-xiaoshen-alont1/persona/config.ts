// Owner: Persona configuration schemas and the Xiaoshen console usage guide.
import type { ConfigGroup } from 'cortico/core/types.ts';

/** 控制台直接展示的只读教程，不参与提示词，也不写入配置。 */
export const XIAOSHEN_USAGE_GROUP: ConfigGroup = {
  id: 'persona:xiaoshen.usage', owner: 'persona', schema: {
    type: 'object', title: '小深人格 · 中文使用教程', properties: {},
    description: '用途：管理人格、工作区记忆和上下文交接。开始：先在语言模型页配置端点与模型，再在提示词页核对自述和宪法，在终端发一条简单问候。记忆：MEMORY 和普通笔记可编辑；RECENT 由 recent_append / recent_read 管理，逐字引用要有已观察的来源，无来源只能记待核。旧 RECENT 原位保留为 legacy-unsourced；来源匹配不代表内容属实，日期取原消息。交接：默认恢复最近 120 分钟内一个私聊的最多 30 条双向消息，预留 2048 tokens，仍受总预算限制。来源缓存默认 7 天、500 条，每条最多 8192 字符；只缓存已投递事件，不补扫历史。下方可关闭有限重复问句回退；QQ 发送受理不等于送达。清理：存储区有独立的对话来源与台账项目，清除它保留旧 RECENT；普通文件工具保护不是操作系统隔离。排查：先核对端点、日志与工作区路径，不要用重置数据排错。',
  },
};

/**
 * 上下文阶段三个裁量与首轮对话开关(`ContextStagePolicy`)的 WebUI 配置组。归属 `persona`:
 * 容量与首轮对话都是 Persona 的参数,core 只持 `hardTokens` 物理钳制与 keepPastThinking。渲染在
 * Persona 页的配置页签。
 *
 * 每个以 Cormini 为骨架的 bot 各声明一次,`id` 按 bot 取;没有这一组的 bot,这三个数在
 * WebUI 上没有位置,只能改 config.json。
 */
export function contextStageConfigGroup(id: string): ConfigGroup {
  return {
    id,
    owner: 'persona',
    schema: {
      type: 'object',
      title: '上下文与交接',
      description:
        '模型窗口与单次输出上限在「语言模型」页配置。上下文达到模型硬限制时由 Core 强制交接。',
      properties: {
        'context.maxTokens': {
          type: 'integer',
          title: '上下文阶段预算',
          minimum: 8000,
          maximum: 2_000_000,
          multipleOf: 1000,
          'x-suffix': 'tok',
          'x-hot': true,
          description:
            '上下文超过阶段预算 × 软阈值比例时先提示；下一批结束时仍超出则交接。',
        },
        'context.keepRatio': {
          type: 'number',
          title: '交接保留比例',
          minimum: 0.05,
          maximum: 0.9,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: '交接笔记预算不超过阶段预算 × 此比例，另受 16384 tokens 与模型硬限制一半的上限约束。先为选中的最近私聊预留额度，余量保留其他近期内容；遗漏会明确计数。',
        },
        'context.softRatio': {
          type: 'number',
          title: '软阈值比例',
          minimum: 0.1,
          maximum: 1,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: '上下文预警阈值 = 阶段预算 × 此比例。',
        },
        'context.firstTurn': {
          type: 'boolean',
          title: '合成首轮对话',
          'x-hot': true,
          description: '把部署 prompts/ 里的首轮对话(FIRST_TURN_USER / THINKING / REPLY)作为合成开头送进每次请求,不写入 session;内容为空时不送。',
        },
      },
    },
  };
}

/** Persona-only handoff policy. The group is reusable by independent bot packages. */
export function conversationConfigGroup(id: string): ConfigGroup {
  return {
    id: id + '.handoff',
    owner: 'persona',
    schema: {
      type: 'object',
      title: '私聊续接与来源核对',
      description: '设置由 Persona 在后续投递、读取或交接时使用。只处理实际观察到的私聊事件；来源核对不等于事实验证。降低缓存上限会淘汰超限来源，台账届时显示来源不可用。',
      properties: {
        'handoff.dialogueWindowMinutes': {
          type: 'integer', title: '私聊恢复时间窗', minimum: 1, maximum: 1440,
          'x-suffix': '分钟', 'x-hot': true,
          description: '默认 120 分钟。交接或重启恢复选中的单个私聊，保留原消息时间、联系人与事件游标。',
        },
        'handoff.dialogueMaxMessages': {
          type: 'integer', title: '私聊恢复消息上限', minimum: 1, maximum: 100,
          'x-suffix': '条', 'x-hot': true,
          description: '默认 30 条双向消息，只选一个私聊，不混入群聊或其他联系人；还受时间窗和 token 预算限制。',
        },
        'handoff.dialogueReserveTokens': {
          type: 'integer', title: '私聊恢复预留预算', minimum: 128, maximum: 8192,
          'x-suffix': 'tok', 'x-hot': true,
          description: '默认 2048 tokens，计入交接总预算，不是额外额度。超限时明确显示遗漏或截断，不保证全部历史保留。',
        },
        'handoff.prioritizeSenderKeys': {
          type: 'string', title: '优先恢复的私聊联系人', 'x-hot': true,
          description: '字符串，填 private:QQ号；多个键用空格或逗号分隔（最多 2048 字符）。在这些联系人中选最近一个会话。留空优先使用已配置的 QQ ownerQQ；没有 owner 时从已观察私聊中选最近有入站消息的会话。',
        },
        'handoff.sourceRetentionHours': {
          type: 'integer', title: '来源缓存保留时长', minimum: 1, maximum: 720,
          'x-suffix': '小时', 'x-hot': true,
          description: '默认 168 小时（7 天），按原消息日期淘汰。来源到期不改写台账日期；之后无法重新核对的记录显示 source-unavailable。',
        },
        'handoff.sourceMaxEvents': {
          type: 'integer', title: '来源缓存事件上限', minimum: 30, maximum: 3000,
          'x-suffix': '条', 'x-hot': true,
          description: '默认 500 个已观察私聊事件，优先保留配置联系人；聚合事件可能包含多条原消息。原文保存在当前 Persona 的 Memory，存储区可单独清除。',
        },
        'handoff.sourceMaxChars': {
          type: 'integer', title: '单事件来源正文上限', minimum: 256, maximum: 32000,
          'x-suffix': '字符', 'x-hot': true,
          description: '默认 8192 字符。超长正文只留连续前缀并标记截断；聚合事件共享正文额度，未保留内容不能用于核对。',
        },
        'handoff.answeredTopicWindowMinutes': {
          type: 'integer', title: '重复问句核对时间窗', minimum: 1, maximum: 1440,
          'x-suffix': '分钟', 'x-hot': true,
          description: '默认 240 分钟。仅使用同一私聊内明确、未截断的近期原回答；原回答不能证明对方此刻仍处于相同状态。',
        },
        'handoff.repeatQuestionFallbackEnabled': {
          type: 'boolean', title: '启用有限重复问句回退', 'x-hot': true,
          description: '默认开启。只核对“吃了吗、在干嘛、睡了吗”等少数短问句；命中已有明确回答时，发送工具返回带原始来源的未发送说明。可关闭；它不是通用语义理解，也不保证识别所有重复提问。',
        },
      },
    },
  };
}
