import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** Alive World 的定义。挂载后它有自己的事（排期/自己的时间/每日回顾）与四个只读的"看得见"工具。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { ALIVE_DEFAULTS, ALIVE_CONFIG_GROUP, type AliveConfigSection } from './config.ts'
import { AliveWorld, ALIVE_TOOL_DECLS } from './world.ts'

export interface AliveDeps {
  dataDir: string
  timezone: string
}

export function createAliveWorld(cfg: AliveConfigSection, deps: AliveDeps): AliveWorld {
  return new AliveWorld({ cfg, dataDir: deps.dataDir, timezone: deps.timezone })
}

export const ALIVE: WorldDefinition<AliveConfigSection> = withWorldPanel({
  id: 'alive',
  label: '能动性',
  defaults: () => ({ ...ALIVE_DEFAULTS }),
  preflight: (ctx) => {
    const cfg = ctx.cfg
    if (!Number.isFinite(cfg.tickSec) || cfg.tickSec < 10) throw new Error('worlds.alive.tickSec 要是 ≥10 的秒数')
    if (!Number.isFinite(cfg.maxPending) || cfg.maxPending < 1) throw new Error('worlds.alive.maxPending 要是 ≥1 的整数')
    if (!Number.isFinite(cfg.expireAfterH) || cfg.expireAfterH < 1) throw new Error('worlds.alive.expireAfterH 要是 ≥1 的小时数')
    try {
      JSON.parse(cfg.pricingJson)
    } catch {
      throw new Error('worlds.alive.pricingJson 不是合法 JSON')
    }
  },
  create: (ctx) => createAliveWorld(ctx.cfg, { dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(ALIVE_TOOL_DECLS, {}),
    events: [
      { type: 'alive.due', description: '自订事项到点的内部调度通知', trigger: 'flush' },
      { type: 'alive.digest', description: '每日回顾的内部调度通知', trigger: 'flush' },
      { type: 'alive.freetime', description: '连续空闲后的内部时间通知', trigger: 'flush' },
      { type: 'alive.material', description: '事项及回顾原始材料，保留来源的外部事件', trigger: 'piggyback' },
    ],
  },
}, PANEL_GUIDE)

export { ALIVE_CONFIG_GROUP }
