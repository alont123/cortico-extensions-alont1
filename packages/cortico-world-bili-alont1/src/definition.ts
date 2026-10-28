import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { BILI_DEFAULTS, normalizeBiliConfig, type BiliConfigSection } from './config.ts';
import { BILI_TOOL_DECLS, BiliWorld } from './world.ts';
export const definition: WorldDefinition<BiliConfigSection> = withWorldPanel({
  id: 'bili', label: 'B站',
  defaults: () => ({ ...BILI_DEFAULTS }),
  create: (ctx) => new BiliWorld(normalizeBiliConfig(ctx.cfg)),
  describe: { tools: describeTools(BILI_TOOL_DECLS, {
    bili_video: { zh: 'B站视频信息', en: 'Bilibili video info' },
    bili_subtitle: { zh: 'B站字幕', en: 'Bilibili subtitles' },
  }), events: [] },
}, PANEL_GUIDE);
