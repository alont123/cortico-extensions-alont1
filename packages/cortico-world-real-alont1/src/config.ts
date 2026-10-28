/**
 * 「看得见的事」World 的配置段：worlds.real。
 *
 * 三个只读视角，都是她原本看不见的事实：
 *   · 主人桌面上正在跑什么（前台窗口 + 进程名，**不截屏**）
 *   · 花了多少钱（按官方价目表估算，高峰/空闲分时段）
 *   · 她自己眼前那份规矩：系统前缀分几段、哪些配置在约束她
 *
 * 只读是刻意的：她能看到、能据此说话，但改不了任何东西。
 */
import type { ConfigGroup } from 'cortico/core/types.ts'

export interface RealConfigSection {
  enabled: boolean

  /**
   * 价格表（JSON）。键是模型名，值是 `[高峰, 空闲]` 两档，单位「元 / 百万 tokens」。
   * 官方价目表 2026-09-23 抄自 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ ；
   * 改价就改这一行，别去改代码。
   */
  pricingJson: string

  /** 「他的桌面」这条最多多久查一次（秒）。防着她一分钟问十遍。 */
  deskGapSec: number

  /** 只看这些进程算"他在忙"？留空 = 都算。写进程名关键字，逗号分隔。 */
  deskProcessFilter: string

  /**
   * 这个实例的控制台端口。`real_prefix` 要 HTTP 回读自己那份前缀——同一个进程的只读接口。
   * 上游框架不把这个端口交给 World（那是本地框架的 `WorldContext.consolePort`），所以在那边只能靠这一项。
   */
  consolePort: number
}

/**
 * 官方价目表（元 / 百万 tokens）：[高峰, 空闲]。
 *
 * 高峰 = 北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00；其余时段（含周末与节假日全天）空闲，
 * 空闲价是高峰的一半。
 */
export const REAL_DEFAULT_PRICING = JSON.stringify({
  'deepseek-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-pro': { hit: [0.30, 0.15], miss: [9.0, 4.5], out: [27.0, 13.5] },
  // 旧模型名仍可调用、按 Flash 计费（官方文档脚注 1）
  'deepseek-v4-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-flash-vision-exp': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
})

export const REAL_DEFAULTS: RealConfigSection = {
  enabled: false,
  pricingJson: REAL_DEFAULT_PRICING,
  deskGapSec: 60,
  deskProcessFilter: '',
  // 框架默认控制台端口。上游框架不给 World 这个值，所以那边读到的就是它。
  consolePort: 7788,
}

export const REAL_CONFIG_GROUP: ConfigGroup = {
  id: 'world:real',
  owner: 'world:real',
  schema: {
    type: 'object',
    title: '看得见的事 · 只读',
    description: '他能看见的东西里，有一部分她原本看不见：他的桌面、花销、以及约束她自己的配置。这里只读，不给写权限。',
    properties: {
      'worlds.real.enabled': {
        type: 'boolean',
        title: '启用',
        'x-hot': false,
        description: '开启后她有 real_desk / real_cost / real_prefix / real_config 四个只读工具。需重启生效。',
      },
      'worlds.real.pricingJson': {
        type: 'string',
        title: '价格表（JSON）',
        'x-hot': true,
        description: '元/百万 tokens，形如 {"deepseek-flash":{"hit":[0.04,0.02],"miss":[2,1],"out":[8,4]}}，数组是[高峰,空闲]。改价改这里。',
      },
      'worlds.real.consolePort': {
        type: 'integer',
        title: '控制台端口',
        minimum: 1,
        maximum: 65535,
        'x-hot': true,
        description: 'real_prefix 回读前缀用的端口，默认 7788（框架默认）。同机跑多个实例时各填各的。',
      },
      'worlds.real.deskGapSec': {
        type: 'integer',
        title: '桌面查询最小间隔',
        minimum: 0,
        maximum: 3600,
        'x-suffix': '秒',
        'x-hot': true,
        description: '防着她一分钟问十遍他在干嘛。',
      },
      'worlds.real.deskProcessFilter': {
        type: 'string',
        title: '只关心这些进程',
        'x-hot': true,
        description: '进程名关键字，逗号分隔；留空 = 都算。用来把后台杂项排除掉。',
      },
    },
  },
}
