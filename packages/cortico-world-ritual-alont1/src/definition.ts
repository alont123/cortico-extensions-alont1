import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 仪式感 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { RITUAL_DEFAULTS, type RitualConfigSection } from './config.ts'
import { RITUAL_TOOL_DECLS, RitualWorld } from './world.ts'

export const RITUAL: WorldDefinition<RitualConfigSection> = withWorldPanel({
  id: 'ritual',
  label: '仪式感',
  defaults: () => ({ ...RITUAL_DEFAULTS }),
  create: (ctx) => new RitualWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(RITUAL_TOOL_DECLS, {
      ritual_set: { zh: '记一个纪念日。', en: 'Records an anniversary.' },
      ritual_list: { zh: '列出纪念日。', en: 'Lists anniversaries.' },
    }),
    events: [
      { type: 'ritual.morning', description: { zh: '到早上了。', en: 'Morning has come.' } },
      { type: 'ritual.night', description: { zh: '到晚上了。', en: 'Night has come.' } },
      { type: 'ritual.anniversary', description: { zh: '已登记纪念日到期；名称原文按 external 外部资料投递。', en: 'A recorded anniversary is due; its original name is external source material.' } },
    ],
  },
}, PANEL_GUIDE)
