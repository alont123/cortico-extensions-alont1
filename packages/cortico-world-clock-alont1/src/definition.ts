import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** Clock World 的定义。挂载后她知道现在几点，并提供一个查询工具。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { CLOCK_DEFAULTS, CLOCK_CONFIG_GROUP, type ClockConfigSection } from './config.ts'
import { ClockWorld, CLOCK_TOOL_DECLS } from './world.ts'

export interface ClockDeps {
  timezone: string
}

export function createClockWorld(cfg: ClockConfigSection, deps: ClockDeps): ClockWorld {
  return new ClockWorld({ cfg, timezone: deps.timezone })
}

export const CLOCK: WorldDefinition<ClockConfigSection> = withWorldPanel({
  id: 'clock',
  label: '现在几点',
  defaults: () => ({ ...CLOCK_DEFAULTS }),
  create: (ctx) => createClockWorld(ctx.cfg, { timezone: ctx.timezone }),
  describe: {
    tools: describeTools(CLOCK_TOOL_DECLS, {}),
    events: [
      {
        type: 'clock.period',
        description: { zh: '报出当前时段。', en: 'Announces the current time period.' },
      },
    ],
  },
}, PANEL_GUIDE)

export { CLOCK_CONFIG_GROUP }
