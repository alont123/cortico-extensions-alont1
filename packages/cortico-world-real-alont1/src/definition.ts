import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** Real World 的定义。挂载后她有四个只读工具：他的桌面、花销、她的前缀、约束她的配置。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { REAL_DEFAULTS, REAL_CONFIG_GROUP, type RealConfigSection } from './config.ts'
import { RealWorld, REAL_TOOL_DECLS } from './world.ts'

export interface RealDeps {
  dataDir: string
  timezone: string
  /** 这个实例的控制台端口：`real_prefix` 回读的是自己那份前缀，端口写死会读到隔壁实例的。 */
  consolePort?: number
}

export function createRealWorld(cfg: RealConfigSection, deps: RealDeps): RealWorld {
  // deps 那边是可选的（上游没有 ctx.consolePort），这里用配置兜底，构造函数的入参仍是确定的数字。
  return new RealWorld({ cfg, dataDir: deps.dataDir, timezone: deps.timezone, consolePort: deps.consolePort ?? cfg.consolePort })
}

export const REAL: WorldDefinition<RealConfigSection> = withWorldPanel({
  id: 'real',
  label: '看得见的事',
  defaults: () => ({ ...REAL_DEFAULTS }),
  preflight: (ctx) => {
    const cfg = ctx.cfg
    try {
      JSON.parse(cfg.pricingJson)
    } catch {
      throw new Error('worlds.real.pricingJson 不是合法 JSON')
    }
    if (!Number.isFinite(cfg.deskGapSec) || cfg.deskGapSec < 0) throw new Error('worlds.real.deskGapSec 要是 ≥0 的秒数')
  },
  // 上游的 WorldContext 没有 consolePort（那是本地框架新增的）：取不到就退回配置里那个端口。
  create: (ctx) => createRealWorld(ctx.cfg, {
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    consolePort: (ctx as unknown as { consolePort?: number }).consolePort ?? ctx.cfg.consolePort,
  }),
  describe: {
    tools: describeTools(REAL_TOOL_DECLS, {}),
    events: [],
  },
}, PANEL_GUIDE)

export { REAL_CONFIG_GROUP }
