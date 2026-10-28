import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { MEMSEARCH_DEFAULTS, normalizeMemsearchConfig, type MemsearchConfigSection } from './config.ts';
import { MEMSEARCH_TOOL_DECLS, MemsearchWorld } from './world.ts';
export const definition: WorldDefinition<MemsearchConfigSection> = withWorldPanel({
  id: 'memsearch', label: '记忆检索',
  defaults: () => ({ ...MEMSEARCH_DEFAULTS }),
  create: (ctx) => new MemsearchWorld({ cfg: normalizeMemsearchConfig(ctx.cfg), botDir: ctx.botDir }),
  describe: { tools: describeTools(MEMSEARCH_TOOL_DECLS, {
    mem_search: { zh: '检索配置资料的原文', en: 'Search configured source files' },
    mem_stats: { zh: '索引状态', en: 'Index stats' },
  }), events: [] },
}, PANEL_GUIDE);
