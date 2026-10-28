import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 人味 World 的定义：七个模块的默认值、启用前检查与构造。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { affinityToolDecls } from './modules/affinity/world.ts'
import { AFFINITY_DEFAULTS } from './modules/affinity/config.ts'
import { CLOCK_TOOL_DECLS } from './modules/clock/world.ts'
import { LEARN_TOOL_DECLS } from './modules/learn/world.ts'
import { LIFE_TOOL_DECLS } from './modules/life/world.ts'
import { MIND_TOOL_DECLS } from './modules/mind/world.ts'
import { REAL_TOOL_DECLS } from './modules/real/world.ts'
import { togetherToolDecls } from './modules/together/world.ts'
import { TOGETHER_DEFAULTS } from './modules/together/config.ts'
import { HUMANLIKE_DEFAULTS, type HumanlikeConfigSection } from './config.ts'
import { HumanlikeWorld } from './world.ts'

export interface HumanlikeDeps {
  dataDir: string
  timezone: string
  botDir?: string
  consolePort?: number
}

export function createHumanlikeWorld(cfg: HumanlikeConfigSection, deps: HumanlikeDeps): HumanlikeWorld {
  return new HumanlikeWorld({ cfg, ...deps })
}

export const HUMANLIKE: WorldDefinition<HumanlikeConfigSection> = withWorldPanel({
  id: 'humanlike',
  label: '人味',
  defaults: () => ({
    enabled: false,
    migrateLegacyData: false,
    affinity: { ...HUMANLIKE_DEFAULTS.affinity },
    learn: { ...HUMANLIKE_DEFAULTS.learn },
    life: { ...HUMANLIKE_DEFAULTS.life },
    clock: { ...HUMANLIKE_DEFAULTS.clock },
    together: { ...HUMANLIKE_DEFAULTS.together },
    mind: { ...HUMANLIKE_DEFAULTS.mind },
    real: { ...HUMANLIKE_DEFAULTS.real },
  }),
  /**
   * 各模块原来的启用前检查，逐条跑一遍；错误信息里的段名跟着配置树走。
   * affinity / learn / life / clock 原本没有 preflight。
   */
  preflight: (ctx) => {
    const cfg = ctx.cfg

    // together
    if (!Number.isFinite(cfg.together.keepDays) || cfg.together.keepDays < 1) {
      throw new Error('worlds.humanlike.together.keepDays 要是 ≥1 的天数')
    }
    if (!Number.isFinite(cfg.together.maxMomentsPerDay) || cfg.together.maxMomentsPerDay < 1) {
      throw new Error('worlds.humanlike.together.maxMomentsPerDay 要是 ≥1 的整数')
    }
    if (!Number.isFinite(cfg.together.threadExpireDays) || cfg.together.threadExpireDays < 1) {
      throw new Error('worlds.humanlike.together.threadExpireDays 要是 ≥1 的天数')
    }

    // mind
    if (!Number.isFinite(cfg.mind.tickSec) || cfg.mind.tickSec < 10) {
      throw new Error('worlds.humanlike.mind.tickSec 要是 ≥10 的秒数')
    }
    if (!Number.isFinite(cfg.mind.maxPending) || cfg.mind.maxPending < 1) {
      throw new Error('worlds.humanlike.mind.maxPending 要是 ≥1 的整数')
    }
    if (!Number.isFinite(cfg.mind.expireAfterH) || cfg.mind.expireAfterH < 1) {
      throw new Error('worlds.humanlike.mind.expireAfterH 要是 ≥1 的小时数')
    }

    // real
    try {
      JSON.parse(cfg.real.pricingJson)
    } catch {
      throw new Error('worlds.humanlike.real.pricingJson 不是合法 JSON')
    }
    if (!Number.isFinite(cfg.real.deskGapSec) || cfg.real.deskGapSec < 0) {
      throw new Error('worlds.humanlike.real.deskGapSec 要是 ≥0 的秒数')
    }
  },
  create: (ctx) => createHumanlikeWorld(ctx.cfg, {
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
    consolePort: (ctx as unknown as { consolePort?: number }).consolePort,
  }),
  describe: {
    tools: describeTools([
      ...affinityToolDecls(AFFINITY_DEFAULTS, AFFINITY_DEFAULTS.favoredId),
      ...CLOCK_TOOL_DECLS,
      ...LEARN_TOOL_DECLS,
      ...LIFE_TOOL_DECLS,
      ...MIND_TOOL_DECLS,
      ...REAL_TOOL_DECLS,
      ...togetherToolDecls(TOGETHER_DEFAULTS.favoredName, TOGETHER_DEFAULTS.favoredKey),
    ], {}),
    events: [
      {
        type: 'clock.period',
        description: { zh: '报出当前时段。', en: 'Announces the current time period.' },
        trigger: 'piggyback',
      },
      {
        type: 'life.reach',
        description: { zh: '她想找某个人说话了。', en: 'It wants to reach out to someone.' },
        trigger: 'flush',
      },
      {
        type: 'together.thread',
        description: { zh: '已登记的未结话头原文，按 external 外部资料投递；是否接话由 Persona 判断。', en: 'Recorded open-thread text delivered as external source material; the Persona decides whether to continue it.' },
        trigger: 'piggyback',
      },
      { type: 'mind.due', description: '自订事项到点的内部调度通知', trigger: 'flush' },
      { type: 'mind.digest', description: '每日回顾的内部调度通知', trigger: 'flush' },
      { type: 'mind.freetime', description: '连续空闲后的内部时间通知', trigger: 'flush' },
      { type: 'mind.material', description: '事项及回顾原始材料，保留来源的外部事件', trigger: 'piggyback' },
    ],
  },
}, PANEL_GUIDE)
