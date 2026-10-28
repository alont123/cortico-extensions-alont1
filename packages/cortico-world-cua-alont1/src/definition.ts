import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { CUA_DEFAULTS, normalizeCuaConfig, type CuaConfigSection } from './config.ts';
import { CuaWorld } from './world.ts';

import { CUA_TOOL_DECLS } from './tool-decls.ts';
export { CUA_TOOL_DECLS } from './tool-decls.ts';

export const definition: WorldDefinition<CuaConfigSection> = withWorldPanel({
  id: 'cua',
  label: '电脑操作',
  defaults: () => ({ ...CUA_DEFAULTS }),
  create(ctx) {
    Object.assign(ctx.cfg, normalizeCuaConfig(ctx.cfg));
    return new CuaWorld(ctx.cfg);
  },
  describe: {
    tools: describeTools(CUA_TOOL_DECLS, {
      cua_free_play: { zh: '申请自己玩电脑。', en: 'Asks for free play time on the computer.' },
      cua_free_allow: { zh: '主人批准自己玩。', en: 'The owner grants free play time.' },
      cua_free_deny: { zh: '主人拒绝自己玩。', en: 'The owner denies free play.' },
      cua_free_status: { zh: '自己玩的状态。', en: 'Free play status.' },
      cua_danger_allow: { zh: '允许一条危险动作并执行。', en: 'Approves and runs one dangerous action.' },
      cua_danger_deny: { zh: '拒绝一条危险动作。', en: 'Denies one dangerous action.' },
    }),
    events: [
      { type: 'cua.free_play_request', description: { zh: '她想自己玩，等主人批准。', en: 'She asks for free play time.' } },
      { type: 'cua.danger_request', description: { zh: '危险动作待批。', en: 'A dangerous action awaits approval.' } },
      { type: 'cua.free_time', description: { zh: '她闲着，可以申请自己玩。', en: 'She is idle and may ask for free play.' } },
    ],
  },
}, PANEL_GUIDE);
