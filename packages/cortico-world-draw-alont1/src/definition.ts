import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { DRAW_DEFAULTS, STYLE_PRESETS, normalizeDrawConfig, type DrawConfigSection } from './config.ts';
import { DRAW_TOOL_DECLS, DrawWorld } from './world.ts';

export const definition: WorldDefinition<DrawConfigSection> = withWorldPanel({
  id: 'draw',
  label: '画图',
  defaults: () => ({ ...DRAW_DEFAULTS }),
  create: (ctx) => new DrawWorld({ cfg: normalizeDrawConfig(ctx.cfg), botDir: ctx.botDir, dataDir: ctx.dataDir }),
  describe: {
    tools: describeTools(DRAW_TOOL_DECLS, {
      draw_image: { zh: '本地生图画一张', en: 'Draw an image locally' },
      draw_status: { zh: '画图服务状态', en: 'Image service status' },
    }),
    events: [],
  },
}, PANEL_GUIDE);
