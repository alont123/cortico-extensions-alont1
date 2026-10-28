/**
 * 建议表：这份表是这份包的**唯一事实来源**（README 里那张清单也是照它写的）。
 *
 * 每条：键路径、为什么、判定方式、建议值、能不能自动改。
 *
 * 三条原则：
 *   · **只收紧**：`--apply` 只会让配置变得更省，不会把任何上限放宽；
 *   · **能关就关、能等就等**：等待便宜的（合并批次），说话贵的（一轮就是一次调用）；
 *   · **改行为的开关默认不自动动**（比如彻底关掉主动说话），只报出来让人自己决定。
 */

export const RULES = [
  // ── 一、最贵的一件事：一条消息 = 一轮 ───────────────────────────────
  {
    path: 'batching.quietGapMs', kind: 'atLeast', value: 1500, suggest: 2500, auto: true,
    title: '连着的消息并成一批的安静窗口（毫秒）',
    why: '太小 = 一条消息一轮；一轮就是一次完整的模型调用。',
  },
  {
    path: 'batching.maxBatchAgeMs', kind: 'atLeast', value: 8000, suggest: 20000, auto: true,
    title: '一批最多等多久（毫秒）',
    why: '等得起：群里本来就吵，攒一批再答比一条一答便宜一个量级。',
  },
  {
    path: 'worlds.qqbot.groupQuietGapMs', kind: 'atLeast', value: 10000, suggest: 12000, auto: true,
    title: '群里：安静多少毫秒算这一批说完了',
    why: '群里最值钱的一个数字。刷屏时它决定一天是几十轮还是几百轮。',
  },
  {
    path: 'worlds.qqbot.groupMaxBatchAgeMs', kind: 'atLeast', value: 15000, suggest: 20000, auto: true,
    title: '群里：一批最多等多久',
    why: '别把话憋过夜，但也别急着答。',
  },

  // ── 二、群里别谁说话都接 ─────────────────────────────────────────────
  {
    path: 'worlds.qqbot.groupActiveDefault', kind: 'atMost', value: 0.35, suggest: 0.35, auto: true,
    title: '不认识的群的默认参与度',
    why: '参与度越高越容易接话。默认摸鱼，特别想让她说话的群再单独调高。',
  },
  {
    path: 'worlds.qqbot.proactiveMinActive', kind: 'atLeast', value: 0.5, suggest: 0.5, auto: true,
    title: '低于这个参与度的群不主动开口',
    why: '主动开口要花两笔（决定说啥 + 真的说），吵的群不值得。',
  },
  {
    path: 'worlds.qqbot.antiLoop.enabled', kind: 'isTrue', suggest: true, auto: true,
    title: '防死循环（连续发言上限）',
    why: '两个 bot 互相接话能接一整天，这是那道刹车。',
  },
  {
    path: 'worlds.qqbot.antiLoop.maxConsecutiveBotTurns', kind: 'atMost', value: 3, suggest: 3, auto: true,
    title: '连续说几句还没人接就停手',
    why: '对方一说话计数就清零，所以调小不误伤。',
  },
  {
    path: 'worlds.qqbot.antiLoop.idleToEndSec', kind: 'atLeast', value: 180, suggest: 300, auto: true,
    title: '多久没人理就收尾（秒）',
    why: '0 = 不收尾，会话会一直挂着，每一拍都可能变成一轮。',
  },
  {
    path: 'worlds.qqbot.groupSpeak.enabled', kind: 'isTrue', suggest: true, auto: true,
    title: '群里发言频率限制',
    why: '没有它，群里刷屏时她可能一句接一句。',
  },
  {
    path: 'worlds.qqbot.groupSpeak.maxPerWindow', kind: 'atMost', value: 8, suggest: 8, auto: true,
    title: '每个窗口里最多说几次',
    why: '配合窗口长度一起看：说得多 = 触发别人回 = 更多轮。',
  },
  {
    path: 'worlds.qqbot.groupSpeak.windowSec', kind: 'atLeast', value: 60, suggest: 60, auto: true,
    title: '上面那个窗口多长（秒）',
    why: '窗口太短等于没限。',
  },

  // ── 三、主动说话：配额与间隔 ─────────────────────────────────────────
  {
    path: 'worlds.qqbot.proactive.dailyQuota', kind: 'atMost', value: 10, suggest: 8, auto: true,
    title: '一天最多主动几次',
    why: '主动说话的每一轮都是钱，而且最容易变成没人理的独白。',
  },
  {
    path: 'worlds.qqbot.proactive.minGapSec', kind: 'atLeast', value: 1800, suggest: 2700, auto: true,
    title: '两次主动之间至少隔多久（秒）',
    why: '把话摊开，别一拍给所有人各发一条。',
  },
  {
    path: 'worlds.qqbot.proactive.enabled', kind: 'isTrue', report: true,
    title: '主动说话总开关',
    why: '最省的一刀是关掉它，但那样她就不主动找人了 —— 自己决定。',
  },

  // ── 四、图片、表情包 ─────────────────────────────────────────────────
  {
    path: 'worlds.qqbot.visionInGroups', kind: 'isFalse', suggest: false, auto: true,
    title: '群里要不要看图',
    why: '一张图进上下文就是一份 token，群里一张顶十句话。',
  },
  {
    path: 'worlds.qqbot.deliverImageAttachmentsInGroups', kind: 'isFalse', suggest: false, auto: true,
    title: '群里要不要把图当附件发进去',
    why: '同上；私聊留着就够。',
  },
  {
    path: 'worlds.qqbot.sticker.enabled', kind: 'isFalse', suggest: false, auto: true,
    title: '自动收藏表情包',
    why: '收藏时要调视觉模型标注情感/用途，是这个开关的隐藏成本。',
  },
  {
    path: 'worlds.qqbot.vision.enabled', kind: 'isFalse', report: true,
    title: '看图总开关',
    why: '私聊看图每张一次视觉调用；用得上就留着，用不上就关。',
  },
  {
    path: 'worlds.qqbot.emotion.enabled', kind: 'isFalse', report: true,
    title: '情绪感知',
    why: '**每来一条消息就跑一次额外调用**，最容易被忽略的一笔。要用就把模型换最便宜的。',
  },
  {
    path: 'worlds.qqbot.splitReplyBySentence', kind: 'isFalse', suggest: false, auto: true,
    title: '回复要不要按句拆成多条',
    why: '拆条会让对方每条都触发新事件，两边互相点火。',
  },

  // ── 五、上下文与轮数（只报，不自动改：改错会伤到长任务） ──────────────
  {
    path: 'rounds.soft', kind: 'atMost', value: 12, report: true,
    title: '一轮对话里的软上限（轮）',
    why: '一个任务最多几次模型调用；调小省钱，但复杂任务会更容易被截断。',
  },
  {
    path: 'rounds.hard', kind: 'atMost', value: 24, report: true,
    title: '硬上限（轮）',
    why: '同上，硬顶。',
  },
  {
    path: 'context.maxTokens', kind: 'atMost', value: 128000, report: true,
    title: '上下文窗口预算',
    why: '预算越大，每轮重发的前缀可以长得越离谱。',
  },
]

/** 端点里的那一项：单独一条规则，因为它住在 providers 目录。 */
export const PROVIDER_RULES = [
  {
    path: 'spec.reasoningEffort', kind: 'oneOf', value: ['low', 'none', 'minimal'], suggest: 'low', auto: true,
    title: '思考强度（仅在开了 thinking 时）',
    why: '思考 token 按输出计价，而出参通常比入参贵一个数量级；闲聊场景 low 就够。',
    onlyWhen: { path: 'spec.thinking', kind: 'isTrue' },
  },
  {
    path: 'spec.thinking', kind: 'isFalse', report: true,
    title: '要不要开思考',
    why: '开了就一定有思考 token；干重活才值得。',
  },
]
