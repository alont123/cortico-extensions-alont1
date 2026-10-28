/** 「一起」的配置段：worlds.humanlike.together。 */
import type { ConfigGroup } from 'cortico/core/types.ts'

export interface TogetherConfigSection {
  /** 攒下来的共同经历保留几天。太老的翻出来不像记得，像在查档案。 */
  keepDays: number;
  /** 往系统前缀里放几条最近的共同经历。 */
  momentsInPrompt: number;
  /** 往系统前缀里放几条还悬着的话头。 */
  threadsInPrompt: number;
  /** 同一个话头最多悬几天，超了自动标成过期（不再进提示词） */
  threadExpireDays: number;
  /** 一天最多记几条。满了之后的调用会被拒，逼她挑重要的记。 */
  maxMomentsPerDay: number;

  /**
   * 那个人的标识。用来把「一起」限定在他身上 —— 群里那些人的事不该进这个账。
   * 空 = 谁都可以。
   */
  favoredKey: string;
  /** 提示词里怎么称呼那个人。 */
  favoredName: string;

  /** 落盘防抖（毫秒）。 */
  flushMs: number;
}

export const TOGETHER_DEFAULTS: TogetherConfigSection = {
  keepDays: 21,
  momentsInPrompt: 6,
  threadsInPrompt: 4,
  threadExpireDays: 14,
  maxMomentsPerDay: 12,
  favoredKey: '',
  favoredName: '他',
  flushMs: 1500,
}

export const TOGETHER_CONFIG_GROUP: ConfigGroup = {
  id: 'world:together',
  owner: 'world:together',
  schema: {
    type: 'object',
    title: '一起',
    description: '她和他之间的事：一起做过什么、聊到哪没聊完。写进系统前缀，改完热生效。',
    properties: {
      'worlds.together.keepDays': {
        type: 'integer', title: '共同经历保留', minimum: 1, maximum: 365,
        'x-suffix': '天', 'x-hot': true,
        description: '共同经历计数与 recall 工具的默认时间范围；更早记录仍保留在文件里。默认 21 天。',
      },
      'worlds.together.momentsInPrompt': {
        type: 'integer', title: '旧版经历条数（兼容项）', minimum: 0, maximum: 20,
        'x-suffix': '条', 'x-hot': true,
        description: '仅为兼容旧配置保留；前缀不再展开经历原文，改用 recall 工具读取。',
      },
      'worlds.together.threadsInPrompt': {
        type: 'integer', title: '旧版话头条数（兼容项）', minimum: 0, maximum: 10,
        'x-suffix': '条', 'x-hot': true,
        description: '仅为兼容旧配置保留；前缀不再展开话头原文，改用 recall 工具读取。',
      },
      'worlds.together.threadExpireDays': {
        type: 'integer', title: '话头最多悬', minimum: 1, maximum: 120,
        'x-suffix': '天', 'x-hot': true,
        description: '超过就自动标过期、不再进提示词。免得她追着问两周前的一句闲话。',
      },
      'worlds.together.maxMomentsPerDay': {
        type: 'integer', title: '一天最多记几条', minimum: 1, maximum: 100,
        'x-suffix': '条', 'x-hot': true,
        description: '满了之后的记录请求会被拒。这是逼她挑重要的，不是在限制能力。',
      },
      'worlds.together.favoredKey': {
        type: 'string', title: '记在谁身上', 'x-hot': false,
        description: '那个人的标识（QQ 号）。填了之后只有他的事进这个账。留空 = 谁都可以。',
      },
      'worlds.together.favoredName': {
        type: 'string', title: '怎么称呼他', 'x-hot': true,
        description: '提示词和回执里用的称呼。默认「他」。',
      },
      'worlds.together.flushMs': {
        type: 'integer', title: '落盘防抖', minimum: 100, maximum: 60_000,
        'x-suffix': '毫秒', 'x-hot': false,
        description: '改动后隔多久写盘。她可能连着记好几条，不必每条都落。',
      },
    },
  },
}
