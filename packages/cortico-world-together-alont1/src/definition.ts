import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 「一起」World 的定义。挂载后她记着你们之间的事，并提供三个工具。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { TOGETHER_DEFAULTS, TOGETHER_CONFIG_GROUP, type TogetherConfigSection } from './config.ts'
import { TogetherWorld, togetherToolDecls } from './world.ts'

export interface TogetherDeps {
  dataDir: string
  timezone: string
}

export function createTogetherWorld(cfg: TogetherConfigSection, deps: TogetherDeps): TogetherWorld {
  return new TogetherWorld({ cfg, dataDir: deps.dataDir, timezone: deps.timezone })
}

export const TOGETHER: WorldDefinition<TogetherConfigSection> = withWorldPanel({
  id: 'together',
  label: '一起',
  defaults: () => ({ ...TOGETHER_DEFAULTS }),
  preflight: (ctx) => {
    const cfg = ctx.cfg
    if (!Number.isFinite(cfg.keepDays) || cfg.keepDays < 1) {
      throw new Error('worlds.together.keepDays 要是 ≥1 的天数')
    }
    if (!Number.isFinite(cfg.maxMomentsPerDay) || cfg.maxMomentsPerDay < 1) {
      throw new Error('worlds.together.maxMomentsPerDay 要是 ≥1 的整数')
    }
    if (!Number.isFinite(cfg.threadExpireDays) || cfg.threadExpireDays < 1) {
      throw new Error('worlds.together.threadExpireDays 要是 ≥1 的天数')
    }
  },
  create: (ctx) => createTogetherWorld(ctx.cfg, {
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
  }),
  describe: {
    tools: describeTools(togetherToolDecls(TOGETHER_DEFAULTS.favoredName, TOGETHER_DEFAULTS.favoredKey), {}),
    events: [
      {
        type: 'together.thread',
        description: { zh: '已登记的未结话头原文，按 external 外部资料投递；是否接话由 Persona 判断。', en: 'Recorded open-thread text delivered as external source material; the Persona decides whether to continue it.' },
      },
    ],
  },
}, PANEL_GUIDE)

export { TOGETHER_CONFIG_GROUP }
