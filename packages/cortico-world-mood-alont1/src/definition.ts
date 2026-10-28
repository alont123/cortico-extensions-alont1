import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 情绪天气 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { MOOD_DEFAULTS, type MoodConfigSection } from './config.ts'
import { MOOD_TOOL_DECLS, MoodWorld } from './world.ts'

export const MOOD: WorldDefinition<MoodConfigSection> = withWorldPanel({
  id: 'mood',
  label: '情绪天气',
  defaults: () => ({ ...MOOD_DEFAULTS }),
  create: (ctx) => new MoodWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(MOOD_TOOL_DECLS, {
      mood_now: { zh: '看使用者现在的状态。', en: "Reads the user's current state." },
    }),
    events: [
      { type: 'mood.changed', description: { zh: '使用者的状态变了（离开/闲着/在忙/在玩）。', en: "The user's state changed." } },
    ],
  },
}, PANEL_GUIDE)
