import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 天气 World 的定义。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts'
import { WEATHER_DEFAULTS, type WeatherConfigSection } from './config.ts'
import { WEATHER_TOOL_DECLS, WeatherWorld } from './world.ts'

export const WEATHER: WorldDefinition<WeatherConfigSection> = withWorldPanel({
  id: 'weather',
  label: '天气',
  defaults: () => ({ ...WEATHER_DEFAULTS }),
  create: (ctx) => new WeatherWorld({ cfg: ctx.cfg }),
  describe: {
    tools: describeTools(WEATHER_TOOL_DECLS, {
      weather_now: { zh: '查现在天气并给出带伞/穿衣提醒。', en: 'Reads the current weather with umbrella and clothing advice.' },
    }),
    events: [],
  },
}, PANEL_GUIDE)
