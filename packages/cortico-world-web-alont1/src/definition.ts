import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { WEB_DEFAULTS, normalizeWebConfig, type WebConfigSection } from './config.ts';
import { WEB_TOOL_DECLS, WebWorld } from './world.ts';

export const definition: WorldDefinition<WebConfigSection> = withWorldPanel({
  id: 'web',
  label: '联网',
  defaults: () => ({ ...WEB_DEFAULTS }),
  create: (ctx) => new WebWorld(normalizeWebConfig(ctx.cfg)),
  describe: {
    tools: describeTools(WEB_TOOL_DECLS, {
      web_find: { zh: '联网搜索', en: 'Web search' },
      web_read: { zh: '读网页正文', en: 'Fetch a page as text' },
    }),
    events: [],
  },
}, PANEL_GUIDE);
