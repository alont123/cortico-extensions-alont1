/** 天气 World：只读地取当前天气，不做推送。 */
import type { ToolDef } from 'cortico/core/types.ts'
import { autoWebUi } from './panel.ts'
import { WEATHER_DEFAULTS } from './config.ts'

export const WEATHER_TOOL_DECLS = [
  {
    name: 'weather_now',
    description: '查现在天气：温度、体感、天气、湿度、风，并给出带伞和穿衣的提醒。想知道出门穿什么、要不要带伞时用。',
    tags: ['read'] as const,
    parameters: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        city: { type: 'string' as const, description: '城市名（中文或英文），不填就用配置里的。' },
      },
    },
  },
]

interface WeatherReading {
  city: string
  temp: number
  feels: number
  desc: string
  humidity: number
  wind: number
  precip: number
}

export class WeatherWorld {
  readonly id = 'weather'
  private readonly city: string

  constructor(opts: { cfg: { city: string } }) {
    this.city = opts.cfg.city
  }

  envPromptVars(): Record<string, string> {
    return {}
  }

  webUi() {
    return autoWebUi('weather', '天气', WEATHER_DEFAULTS)
  }
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  tools(): ToolDef[] {
    return WEATHER_TOOL_DECLS.map((decl) => ({
      ...decl,
      tags: [...decl.tags],
      handler: async (args: Record<string, unknown>) => {
        const city = String(args.city ?? '').trim() || this.city
        const reading = await this.read(city)
        if (!reading) return '天气没查到（网络或城市名的问题），过一会儿再试。'
        return describe(reading)
      },
    }))
  }

  private async read(city: string): Promise<WeatherReading | null> {
    const target = city ? encodeURIComponent(city) : ''
    try {
      const res = await fetch('https://wttr.in/' + target + '?format=j1', {
        headers: { 'user-agent': 'curl/8.0', accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return null
      const j = (await res.json()) as {
        current_condition?: Array<Record<string, unknown>>
        weather?: Array<{ mintempC?: string; maxtempC?: string }>
      }
      const cur = j.current_condition?.[0]
      if (!cur) return null
      if (['temp_C', 'FeelsLikeC', 'humidity', 'windspeedKmph', 'precipMM'].some(key => cur[key] === undefined || cur[key] === '' || !Number.isFinite(Number(cur[key])))) return null
      const lang = cur.lang_zh as Array<Record<string, string>> | undefined
      const descs = cur.weatherDesc as Array<Record<string, string>> | undefined
      return {
        city: city || '你那儿',
        temp: Number(cur.temp_C ?? 0),
        feels: Number(cur.FeelsLikeC ?? 0),
        desc: lang?.[0]?.value ?? descs?.[0]?.value ?? '未知',
        humidity: Number(cur.humidity ?? 0),
        wind: Number(cur.windspeedKmph ?? 0),
        precip: Number(cur.precipMM ?? 0),
      }
    } catch {
      return null
    }
  }
}

/** 把读数说成一句话，带上带伞和穿衣的提醒。 */
function describe(r: WeatherReading): string {
  const parts = [`${r.city}：${r.desc}，${r.temp}℃（体感 ${r.feels}℃）`, `湿度 ${r.humidity}%`, `风 ${r.wind} km/h`]
  parts.push(`服务报告降水量 ${r.precip}mm`)
  const advice: string[] = []
  if (r.precip > 0 || r.humidity >= 85) advice.push('出门带伞')
  if (r.feels <= 5) advice.push('穿厚点')
  else if (r.feels <= 12) advice.push('加件外套')
  else if (r.feels >= 30) advice.push('穿薄点、多喝水')
  return parts.join('，') + (advice.length ? '。' + advice.join('，') + '。' : '。')
}
