/**
 * Clock World 的配置段：worlds.clock。
 *
 * 默认是关的。开着它不改变她能看到的任何事实，只是把"现在几点"这件事补上 ——
 * 没有它的时候，她上下文里唯一的时间线索是各条消息自带的时间戳，
 * 一下午没人说话，她看到的最后一个时间就是几小时前的。
 */
import type { ConfigGroup } from 'cortico/core/types.ts'

/** 主动报时的时机。用单选而不是数组：配置组里数组没有先例，单选的取舍也更清楚。 */
export type ClockAnnounce = 'off' | 'quiet-hours' | 'all'

export interface ClockConfigSection {
  enabled: boolean

  /**
   * 时段变化时主动说一句。
   *
   * - `off`：不说。她问的时候照常能报（`clock_now`），只是不会自己开口。
   * - `quiet-hours`：只在清晨和深夜说 —— 一天开始、该睡了，这两个点是有意义的。
   *   中午、下午这类"白天"说出来只是噪音。
   * - `all`：每个时段变化都说，一天七八次。
   */
  announce: ClockAnnounce

  /**
   * 两次主动之间至少隔多久（分钟）。
   *
   * 重启、时钟被校、夏令时都可能让同一个时段在几分钟内被判成"刚进入"两次。
   */
  announceGapMinutes: number
}

export const CLOCK_DEFAULTS: ClockConfigSection = {
  enabled: false,
  announce: 'quiet-hours',
  announceGapMinutes: 30,
}

export const CLOCK_CONFIG_GROUP: ConfigGroup = {
  id: 'world:clock',
  owner: 'world:clock',
  schema: {
    type: 'object',
    title: '现在几点',
    description: '把钟点和时段交给她。一天里的时间线索本来只有消息自带的时间戳，久没人说话就断了。改动热生效。',
    properties: {
      'worlds.clock.announce': {
        type: 'string',
        title: '主动报时的时机',
        enum: ['off', 'quiet-hours', 'all'],
        'x-hot': true,
        description: 'off=不主动说，只能她问；quiet-hours=只在清晨和深夜说（一天开始、该睡了）；'
          + 'all=每个时段变化都说，一天七八次。',
      },
      'worlds.clock.announceGapMinutes': {
        type: 'integer',
        title: '两次主动至少隔',
        minimum: 1,
        maximum: 240,
        'x-suffix': '分钟',
        'x-hot': true,
        description: '重启或校时可能让同一个时段被连报两次，靠这个挡住。',
      },
    },
  },
}
