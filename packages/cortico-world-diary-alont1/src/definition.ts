import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 截图日记 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { DIARY_DEFAULTS, type DiaryConfigSection } from './config.ts'
import { DIARY_TOOL_DECLS, DiaryWorld } from './world.ts'

export const DIARY: WorldDefinition<DiaryConfigSection> = withWorldPanel({
  id: 'diary',
  label: '截图日记',
  defaults: () => ({ ...DIARY_DEFAULTS }),
  create: (ctx) => new DiaryWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(DIARY_TOOL_DECLS, {
      diary_snap: { zh: '截屏存进今天的日记。', en: "Saves a screenshot into today's diary." },
      diary_today: { zh: '看今天的日记。', en: "Reads today's diary." },
      diary_list: { zh: '最近几天的日记。', en: 'Lists recent diary days.' },
    }),
    events: [],
  },
}, PANEL_GUIDE)
