/**
 * 惦记 World 的配置段：worlds.mind。
 *
 * 这个 World 只做一件事：**把她自己记下的"我想做点什么"按她定的时间还给她。**
 * 它不生成任何一句话——推回去的正文是她写下的原文，所以她不会被安上没说过的话；
 * 它也不替她决定做不做，到点只是提醒"这是你自己说的"。
 *
 * 默认关闭：这是一个实验，开着它就等于给她一个能自己排期的口子。
 */
import type { ConfigGroup } from 'cortico/core/types.ts'

export interface MindConfigSection {
  enabled: boolean

  /** 检查到点的节拍（秒）。默认 60：她是"过一会儿想起来"的粒度，不需要秒级。 */
  tickSec: number

  /**
   * 同时最多惦记几件。
   *
   * 挂太多就等于没有重点，而且每一件到点都会打断她一次。
   */
  maxPending: number

  /**
   * 两次提醒之间至少隔多久（秒）。
   *
   * 没有这道闸门，攒了几件到点的会一口气全砸给她——那更像系统报警，不是"想起来"。
   */
  pushGapSec: number

  /** 一天最多提醒几次。0 = 不限。 */
  dailyPushes: number

  /**
   * 夜间静默：这个点之后不提醒，到早上再给（跨夜写法同 qzone 的 quietFrom/quietTo）。
   * 两值相等 = 不静默。夜里攒下的条目不会消失，只是等天亮。
   */
  quietFrom: number
  quietTo: number

  /**
   * 提醒过、她也一直没理的条目，多久之后自动清掉（小时）。
   *
   * 「没做」也是一种回答。留着它反复冒出来只会变成唠叨；过期后 `mind_list` 里还能看到痕迹（记在 recently 里）。
   */
  expireAfterH: number

  /**
   * 一天给她几段「自己的时间」：推一条**不带任何目标**的事件，让她想做点什么就做点什么。
   *
   * 0 = 不给。此事件只含时间提示，不附任务或外部原话。
   */
  freeTimePerDay: number

  /** 两段「自己的时间」的间隔及无外部消息的静默窗口（分钟，至少 30）。 */
  freeTimeGapMin: number

  /**
   * 今日回顾：每天这个钟点把"今天真发生过的"整理成材料递给她（形如 "22:30"）。
   * 空 = 不推。她写不写、写什么由她自己定，这里只负责把材料放到眼前。
   */
  digestAt: string

  /** 素材里放几条今天的原话片段。 */
  digestEvents: number

  /**
   * 已弃用，保留旧配置兼容。World 不读取 Memory。
   */
  memoryDir: string
}

export const MIND_DEFAULTS: MindConfigSection = {
  enabled: false,
  tickSec: 60,
  maxPending: 5,
  pushGapSec: 900,
  dailyPushes: 8,
  quietFrom: 23,
  quietTo: 9,
  expireAfterH: 24,
  freeTimePerDay: 3,
  freeTimeGapMin: 180,
  digestAt: '',
  digestEvents: 24,
  memoryDir: '',
}

export const MIND_CONFIG_GROUP: ConfigGroup = {
  id: 'world:mind',
  owner: 'world:mind',
  schema: {
    type: 'object',
    title: '惦记 · 她自己的事',
    description: '她自己排期的事：到点由框架把她的原话还给她。这是一个实验性 World，关掉它不影响别的任何东西。',
    properties: {
      'worlds.mind.enabled': {
        type: 'boolean',
        title: '启用',
        'x-hot': false,
        description: '开启后她有 mind_want / mind_list / mind_done / mind_drop 四个工具，能自己安排"什么时候做什么"。需重启生效。',
      },
      'worlds.mind.tickSec': {
        type: 'integer',
        title: '检查节拍',
        minimum: 10,
        maximum: 3600,
        'x-suffix': '秒',
        'x-hot': true,
        description: '多久看一眼有没有到点的事。',
      },
      'worlds.mind.maxPending': {
        type: 'integer',
        title: '同时最多惦记几件',
        minimum: 1,
        maximum: 20,
        'x-suffix': '件',
        'x-hot': true,
        description: '挂太多就没有重点，而且每件到点都要打断她一次。',
      },
      'worlds.mind.pushGapSec': {
        type: 'integer',
        title: '两次提醒最小间隔',
        minimum: 0,
        maximum: 86400,
        'x-suffix': '秒',
        'x-hot': true,
        description: '防止攒着的几件一口气全砸给她。',
      },
      'worlds.mind.dailyPushes': {
        type: 'integer',
        title: '每天最多提醒几次',
        minimum: 0,
        maximum: 100,
        'x-suffix': '次',
        'x-hot': true,
        description: '0 = 不限。每次提醒都会让她走一轮，这是成本闸门。',
      },
      'worlds.mind.quietFrom': {
        type: 'integer',
        title: '夜间静默开始（点）',
        minimum: 0,
        maximum: 23,
        'x-suffix': '时',
        'x-hot': true,
        description: '这个点之后不提醒，攒到早上。跨夜按 quietFrom > quietTo 读；两值相等 = 不静默。',
      },
      'worlds.mind.quietTo': {
        type: 'integer',
        title: '夜间静默结束（点）',
        minimum: 0,
        maximum: 23,
        'x-suffix': '时',
        'x-hot': true,
        description: '这个点之前不提醒。',
      },
      'worlds.mind.expireAfterH': {
        type: 'integer',
        title: '没做就多久清掉',
        minimum: 1,
        maximum: 720,
        'x-suffix': '小时',
        'x-hot': true,
        description: '提醒过、她也一直没理的条目，过了这么久自动清掉——没做也是一种回答。',
      },
      'worlds.mind.freeTimePerDay': {
        type: 'integer',
        title: '一天几段自己的时间',
        minimum: 0,
        maximum: 12,
        'x-suffix': '段',
        'x-hot': true,
        description: '推一条不带目标的事件，让她想做点什么就做点什么（也可以什么都不做）。0 = 不给。',
      },
      'worlds.mind.freeTimeGapMin': {
        type: 'integer',
        title: '自己的时间间隔与静默窗口',
        minimum: 30,
        maximum: 1440,
        'x-suffix': '分',
        'x-hot': true,
        description: '距离上一段自己的时间至少间隔这么久，且此窗口内没有新的外部事件时才推送。',
      },
      'worlds.mind.digestAt': {
        type: 'string',
        title: '今日回顾钟点',
        'x-hot': true,
        description: '每天这个点（如 22:30）把今天真发生过的整理成材料递给她；空 = 不推。',
      },
      'worlds.mind.digestEvents': {
        type: 'integer',
        title: '回顾带几条原话',
        minimum: 4,
        maximum: 80,
        'x-suffix': '条',
        'x-hot': true,
        description: '素材里放今天最近几条真实事件的原话片段。',
      },
      'worlds.mind.memoryDir': {
        type: 'string',
        title: '记忆目录（已弃用）',
        'x-hot': false,
        description: '保留旧配置兼容，World 不读取此目录。Memory 由 Persona 的工具读取。',
      },
    },
  },
}
