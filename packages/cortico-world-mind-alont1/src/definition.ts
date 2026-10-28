import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** Mind World 的定义。挂载后她能给自己记下想做的事，到点由框架把她的原话还给她。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { MIND_DEFAULTS, MIND_CONFIG_GROUP, type MindConfigSection } from './config.ts'
import { MindWorld, MIND_TOOL_DECLS } from './world.ts'

export interface MindDeps {
  dataDir: string
  timezone: string
}

export function createMindWorld(cfg: MindConfigSection, deps: MindDeps): MindWorld {
  return new MindWorld({ cfg, dataDir: deps.dataDir, timezone: deps.timezone })
}

export const MIND: WorldDefinition<MindConfigSection> = withWorldPanel({
  id: 'mind',
  label: '惦记 · 她自己的事',
  defaults: () => ({ ...MIND_DEFAULTS }),
  preflight: (ctx) => {
    const cfg = ctx.cfg
    if (!Number.isFinite(cfg.tickSec) || cfg.tickSec < 10) throw new Error('worlds.mind.tickSec 要是 ≥10 的秒数')
    if (!Number.isFinite(cfg.maxPending) || cfg.maxPending < 1) throw new Error('worlds.mind.maxPending 要是 ≥1 的整数')
    if (!Number.isFinite(cfg.expireAfterH) || cfg.expireAfterH < 1) throw new Error('worlds.mind.expireAfterH 要是 ≥1 的小时数')
  },
  create: (ctx) => createMindWorld(ctx.cfg, { dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(MIND_TOOL_DECLS, {}),
    events: [
      { type: 'mind.due', description: '自订事项到点的内部调度通知', trigger: 'flush' },
      { type: 'mind.digest', description: '每日回顾的内部调度通知', trigger: 'flush' },
      { type: 'mind.freetime', description: '连续空闲后的内部时间通知', trigger: 'flush' },
      { type: 'mind.material', description: '事项及回顾原始材料，保留来源的外部事件', trigger: 'piggyback' },
    ],
  },
}, PANEL_GUIDE)

export { MIND_CONFIG_GROUP }
