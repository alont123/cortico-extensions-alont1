import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 轻量 World 的定义。挂载后她多知道两件事：现在几点、以及她记着关于他的什么。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { LITE_CONFIG_GROUP, LITE_DEFAULTS, type LiteConfigSection } from './config.ts'
import { LiteWorld, liteToolDecls } from './world.ts'

export interface LiteDeps {
  dataDir: string
  timezone: string
}

export function createLiteWorld(cfg: LiteConfigSection, deps: LiteDeps): LiteWorld {
  return new LiteWorld({ cfg, dataDir: deps.dataDir, timezone: deps.timezone })
}

export const LITE: WorldDefinition<LiteConfigSection> = withWorldPanel({
  id: 'lite',
  label: '轻量',
  defaults: () => ({ ...LITE_DEFAULTS }),
  preflight: (ctx) => {
    const cfg = ctx.cfg
    if (!Number.isFinite(cfg.maxNotes) || cfg.maxNotes < 3) throw new Error('worlds.lite.maxNotes 要是 ≥3 的整数')
    if (!Number.isFinite(cfg.noteChars) || cfg.noteChars < 10) throw new Error('worlds.lite.noteChars 要是 ≥10 的整数')
  },
  create: (ctx) => createLiteWorld(ctx.cfg, { dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(liteToolDecls(LITE_DEFAULTS.noteChars), {}),
    events: [],
  },
}, PANEL_GUIDE)

export { LITE_CONFIG_GROUP }
