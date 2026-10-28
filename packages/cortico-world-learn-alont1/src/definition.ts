import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 学习 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { LEARN_DEFAULTS, LEARN_CONFIG_GROUP, type LearnConfigSection } from './config.ts';
import { LearnWorld, LEARN_TOOL_DECLS } from './world.ts';

export const LEARN: WorldDefinition<LearnConfigSection> = withWorldPanel({
  id: 'learn',
  label: '学习',
  defaults: () => ({ ...LEARN_DEFAULTS }),
  create: (ctx) => new LearnWorld({ cfg: ctx.cfg, dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(LEARN_TOOL_DECLS, {}),
    events: [
      {
        type: 'learn.started',
        description: { zh: '学习 World 挂载后开始工作。', en: 'The learn World started working.' },
      },
    ],
  },
}, PANEL_GUIDE);

export { LEARN_CONFIG_GROUP };
