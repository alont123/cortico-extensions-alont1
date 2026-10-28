import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 玩具世界的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { PLAYGROUND_DEFAULTS, type PlaygroundConfigSection } from './config.ts'
import { PLAYGROUND_TOOL_DECLS, PlaygroundWorld } from './world.ts'

export const PLAYGROUND: WorldDefinition<PlaygroundConfigSection> = withWorldPanel({
  id: 'playground',
  label: '玩具世界',
  defaults: () => ({ ...PLAYGROUND_DEFAULTS }),
  create: (ctx) => new PlaygroundWorld({ botDir: ctx.botDir, dataDir: ctx.dataDir, cfg: ctx.cfg }),
  describe: {
    tools: describeTools(PLAYGROUND_TOOL_DECLS, {
      play_run: { zh: '在玩具目录里跑一小段 JS。', en: 'Runs a small JS snippet in the play folder.' },
      play_list: { zh: '列出玩具目录。', en: 'Lists the play folder.' },
    }),
    events: [],
  },
}, PANEL_GUIDE)
