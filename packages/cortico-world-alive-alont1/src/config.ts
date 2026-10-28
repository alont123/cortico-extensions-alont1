/**
 * 能动性 World 的配置段：worlds.alive。
 *
 * 两半：
 *   ① 它自己的事 —— 自己记下想做什么、到点被提醒、有自己的时间、每天回顾一次。
 *   ② 看得见的事 —— 你在桌面上干什么、花了多少钱、它眼前那份系统提示与约束它的配置（只读）。
 *
 * 默认关闭：这一整包都是在给 bot 更多自主权，开不开该由运维决定。
 */
import type { ConfigGroup } from 'cortico/core/types.ts'

export interface AliveConfigSection {
  enabled: boolean

  // ── ① 它自己的事 ───────────────────────────────────────────────────────

  /** 检查到点的节拍（秒）。 */
  tickSec: number
  /** 同时最多记着几件。挂太多就没有重点，而且每件到点都会打断它一次。 */
  maxPending: number
  /** 两次推送之间至少隔多久（秒）：到点的提醒、"自己的时间"、"每日回顾"共用这一道闸门。 */
  pushGapSec: number
  /** 一天最多推送几次。0 = 不限。每一次推送都会让它走一轮，这是成本闸门。 */
  dailyPushes: number
  /** 夜间静默开始（点）。跨夜写法：quietFrom > quietTo。两值相等 = 不静默。 */
  quietFrom: number
  /** 夜间静默结束（点）。 */
  quietTo: number
  /** 提醒过、一直没理的条目，多少小时后自动清掉。「没做」也是一种回答。 */
  expireAfterH: number
  /** 一天给几段「自己的时间」：推一条不带任何目标的事件。0 = 不给。 */
  freeTimePerDay: number
  /** 两段「自己的时间」的间隔及无外部消息的静默窗口（分钟，至少 30）。 */
  freeTimeGapMin: number
  /** 每日回顾钟点，形如 "22:30"。空 = 不推。 */
  digestAt: string
  /** 回顾素材里放几条最近的原话片段。 */
  digestEvents: number
  /**
   * 已弃用，保留旧配置兼容。World 不读取 Memory。
   */
  memoryDir: string
  /** 已弃用，保留旧配置兼容。 */
  recentFile: string

  // ── ② 看得见的事 ───────────────────────────────────────────────────────

  /**
   * 价格表（JSON）：元 / 百万 tokens，数组是 [高峰, 空闲]。
   * 账本里只有 token 数、没有金额，所以钱是照这张表估算的。改价改这里。
   */
  pricingJson: string
  /** 桌面查询最小间隔（秒），防它一分钟问十遍。 */
  deskGapSec: number
  /** 只关心这些进程（逗号分隔的进程名关键字）；留空 = 都算。 */
  deskProcessFilter: string
  /** 本机控制台地址：`prefix` 那条要看系统提示是怎么拼的，只读接口。 */
  consoleUrl: string
}

/** 官方 DeepSeek 价目表（元 / 百万 tokens，[高峰, 空闲]），2026-09 抄自 api-docs。 */
export const ALIVE_DEFAULT_PRICING = JSON.stringify({
  'deepseek-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-pro': { hit: [0.30, 0.15], miss: [9.0, 4.5], out: [27.0, 13.5] },
  'deepseek-v4-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-flash-vision-exp': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
})

export const ALIVE_DEFAULTS: AliveConfigSection = {
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
  recentFile: 'RECENT.md',
  pricingJson: ALIVE_DEFAULT_PRICING,
  deskGapSec: 60,
  deskProcessFilter: '',
  consoleUrl: 'http://127.0.0.1:7788',
}

export const ALIVE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:alive',
  owner: 'world:alive',
  schema: {
    type: 'object',
    title: '能动性 · 它自己的事与看得见的事',
    description: '给 bot 一点自主权：自己排期想做的事、有自己的时间、每天回顾一次；另外让它看得见你的桌面、花销和约束它自己的配置（只读）。',
    properties: {
      'worlds.alive.enabled': { type: 'boolean', title: '启用', 'x-hot': false, description: '开启后它有 alive_want / alive_list / alive_done / alive_drop / alive_desk / alive_cost / alive_prefix / alive_config 八个工具。需重启生效。' },
      'worlds.alive.tickSec': { type: 'integer', title: '检查节拍', minimum: 10, maximum: 3600, 'x-suffix': '秒', 'x-hot': true, description: '多久看一眼有没有到点的事。' },
      'worlds.alive.maxPending': { type: 'integer', title: '同时最多记着几件', minimum: 1, maximum: 20, 'x-suffix': '件', 'x-hot': true, description: '挂太多就没有重点，而且每件到点都要打断它一次。' },
      'worlds.alive.pushGapSec': { type: 'integer', title: '两次推送最小间隔', minimum: 0, maximum: 86400, 'x-suffix': '秒', 'x-hot': true, description: '防攒着的几件一口气全砸给它。' },
      'worlds.alive.dailyPushes': { type: 'integer', title: '每天最多推送几次', minimum: 0, maximum: 100, 'x-suffix': '次', 'x-hot': true, description: '0 = 不限。每次推送都会让它走一轮，这是成本闸门。' },
      'worlds.alive.quietFrom': { type: 'integer', title: '静默开始（点）', minimum: 0, maximum: 23, 'x-suffix': '时', 'x-hot': true, description: '这个点之后不推送，攒到早上。跨夜按 quietFrom > quietTo 读；两值相等 = 不静默。' },
      'worlds.alive.quietTo': { type: 'integer', title: '静默结束（点）', minimum: 0, maximum: 23, 'x-suffix': '时', 'x-hot': true, description: '这个点之前不推送。' },
      'worlds.alive.expireAfterH': { type: 'integer', title: '没做就多久清掉', minimum: 1, maximum: 720, 'x-suffix': '小时', 'x-hot': true, description: '提醒过、一直没理的条目过了这么久自动清掉——没做也是一种回答。' },
      'worlds.alive.freeTimePerDay': { type: 'integer', title: '一天几段自己的时间', minimum: 0, maximum: 12, 'x-suffix': '段', 'x-hot': true, description: '推一条不带目标的事件，让它想做点什么就做点什么（也可以什么都不做）。0 = 不给。' },
      'worlds.alive.freeTimeGapMin': { type: 'integer', title: '自己的时间间隔与静默窗口', minimum: 30, maximum: 1440, 'x-suffix': '分', 'x-hot': true, description: '距离上一段自己的时间至少间隔这么久，且此窗口内没有新的外部事件时才推送。' },
      'worlds.alive.digestAt': { type: 'string', title: '每日回顾钟点', 'x-hot': true, description: '每天这个点（如 22:30）把最近真发生过的事整理成材料递过去；空 = 不推。' },
      'worlds.alive.digestEvents': { type: 'integer', title: '回顾带几条原话', minimum: 4, maximum: 80, 'x-suffix': '条', 'x-hot': true, description: '素材里放最近几条真实事件的原话片段。' },
      'worlds.alive.memoryDir': { type: 'string', title: '记忆目录（已弃用）', 'x-hot': false, description: '保留旧配置兼容，World 不读取此目录。Memory 由 Persona 的工具读取。' },
      'worlds.alive.recentFile': { type: 'string', title: '近况文件名（已弃用）', 'x-hot': false, description: '保留旧配置兼容，World 不读取此文件。' },
      'worlds.alive.pricingJson': { type: 'string', title: '价格表（JSON）', 'x-hot': true, description: '元/百万 tokens，形如 {"模型名":{"hit":[0.04,0.02],"miss":[2,1],"out":[8,4]}}，数组是 [高峰, 空闲]。' },
      'worlds.alive.deskGapSec': { type: 'integer', title: '桌面查询最小间隔', minimum: 0, maximum: 3600, 'x-suffix': '秒', 'x-hot': true, description: '防它一分钟问十遍你在干嘛。' },
      'worlds.alive.deskProcessFilter': { type: 'string', title: '只关心这些进程', 'x-hot': true, description: '进程名关键字，逗号分隔；留空 = 都算。' },
      'worlds.alive.consoleUrl': { type: 'string', title: '控制台地址', 'x-hot': false, description: '本机控制台，alive_prefix 读它的只读接口看系统提示分了几段。' },
    },
  },
}
