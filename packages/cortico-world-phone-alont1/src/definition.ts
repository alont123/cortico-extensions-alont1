import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { PHONE_DEFAULTS, normalizePhoneConfig, type PhoneConfigSection } from './config.ts';
import { PHONE_TOOL_DECLS, PhoneWorld } from './world.ts';
export const definition: WorldDefinition<PhoneConfigSection> = withWorldPanel({
  id: 'phone', label: '手机',
  defaults: () => ({ ...PHONE_DEFAULTS }),
  create: (ctx) => new PhoneWorld({ cfg: normalizePhoneConfig(ctx.cfg), botDir: ctx.botDir, dataDir: ctx.dataDir }),
  describe: { tools: describeTools(PHONE_TOOL_DECLS, {
    phone_status: { zh: '手机状态', en: 'Phone status' },
    phone_launch: { zh: '开手机', en: 'Launch phone' },
    phone_screenshot: { zh: '手机截屏', en: 'Phone screenshot' },
    phone_tap: { zh: '点屏幕', en: 'Tap' },
    phone_swipe: { zh: '滑动', en: 'Swipe' },
    phone_text: { zh: '输入英文', en: 'Type ASCII' },
    phone_key: { zh: '按键', en: 'Press key' },
    phone_apps: { zh: '已装应用', en: 'List apps' },
    phone_open: { zh: '打开应用', en: 'Open app' },
    phone_sh: { zh: '跑 shell', en: 'Run shell' },
    phone_close: { zh: '关手机', en: 'Shutdown' },
  }), events: [] },
}, PANEL_GUIDE);
