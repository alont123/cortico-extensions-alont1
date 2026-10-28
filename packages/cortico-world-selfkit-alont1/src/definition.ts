import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { SELFKIT_DEFAULTS, normalizeSelfkitConfig, type SelfkitConfigSection } from './config.ts';
import { SELFKIT_TOOL_DECLS, SelfkitWorld } from './world.ts';

export const definition: WorldDefinition<SelfkitConfigSection> = withWorldPanel({
  id: 'selfkit',
  label: '自我运维',
  defaults: () => ({ ...SELFKIT_DEFAULTS }),
  create: (ctx) => new SelfkitWorld(normalizeSelfkitConfig(ctx.cfg)),
  describe: {
    tools: describeTools(SELFKIT_TOOL_DECLS, {
      self_status: { zh: '自己的运行状态', en: 'Own runtime status' },
      self_log: { zh: '自己的告警日志', en: 'Own warning log' },
      self_worlds: { zh: '自己挂的世界', en: 'Own mounted worlds' },
    }),
    events: [],
  },
}, PANEL_GUIDE);
