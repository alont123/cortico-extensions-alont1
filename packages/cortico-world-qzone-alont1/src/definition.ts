import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** QQ 空间 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { QZONE_DEFAULTS, QZONE_CONFIG_GROUP, type QzoneConfigSection } from './config.ts';
import { QzoneWorld, QZONE_TOOL_DECLS } from './world.ts';

export const QZONE: WorldDefinition<QzoneConfigSection> = withWorldPanel({
  id: 'qzone',
  label: 'QQ空间',
  defaults: () => ({ ...QZONE_DEFAULTS }),
  create: (ctx) => new QzoneWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    botDir: ctx.botDir,
    timezone: ctx.timezone,
    // 端点必须从配置来：一台机器上跑多个实例时各家的 NapCat 端口不一样，
    // 写死就会把说说发到别人的账号上（见 config.ts 里 httpUrl 的说明）。
    httpUrl: ctx.cfg.httpUrl,
  }),
  describe: {
    tools: describeTools(QZONE_TOOL_DECLS, {}),
    events: [
      {
        type: 'qzone.started',
        description: { zh: 'QQ 空间 World 挂载后开始工作。', en: 'The Qzone World started working.' },
      },
      {
        type: 'qzone.nudge',
        description: { zh: '到点了,该去 QQ 空间看看或发点什么。', en: 'It is time to look at or post to Qzone.' },
      },
    ],
  },
}, PANEL_GUIDE);

export { QZONE_CONFIG_GROUP };
