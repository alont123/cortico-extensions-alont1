import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { MEME_DEFAULTS, type MemeConfigSection } from './config.ts';
import { MEME_TOOL_DECLS, MemeWorld } from './world.ts';

export const definition: WorldDefinition<MemeConfigSection> = withWorldPanel({
  id: 'meme',
  label: '梗',
  defaults: () => ({ ...MEME_DEFAULTS }),
  create: (ctx) => new MemeWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(MEME_TOOL_DECLS, {
      meme_search: { zh: '查梗', en: 'Search meme' },
      meme_chain: { zh: '验接龙', en: 'Verify meme followup' },
      meme_note: { zh: '记梗', en: 'Remember meme' },
      meme_stats: { zh: '查梗用量', en: 'Meme usage' },
    }),
    events: [],
  },
}, PANEL_GUIDE);
