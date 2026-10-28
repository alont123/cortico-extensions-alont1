import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { WORKS_DEFAULTS, normalizeWorksConfig, type WorksConfigSection } from './config.ts';
import { WORKS_TOOL_DECLS, WorksWorld } from './world.ts';
export const definition: WorldDefinition<WorksConfigSection> = withWorldPanel({
  id: 'works', label: '作品页',
  defaults: () => ({ ...WORKS_DEFAULTS }),
  create: (ctx) => new WorksWorld({ dataDir: ctx.dataDir, botDir: ctx.botDir }),
  describe: { tools: describeTools(WORKS_TOOL_DECLS, {
    works_add: { zh: '收一件作品', en: 'Add a work' },
    works_list: { zh: '列作品', en: 'List works' },
    works_page: { zh: '生成作品页', en: 'Generate works page' },
    works_import_image: { zh: '从附件收录图片', en: 'Import an image attachment' },
  }), events: [] },
}, PANEL_GUIDE);
