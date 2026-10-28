/** 仪式感 World：两个时刻各冒一次泡，纪念日另算。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts'
import { nowIso } from 'cortico/core/util.ts'
import { autoWebUi } from './panel.ts'
import { RITUAL_DEFAULTS } from './config.ts'

export const RITUAL_TOOL_DECLS = [
  {
    name: 'ritual_set',
    description: '记下一个纪念日：月-日 + 名字。到那天她会主动提一句。',
    tags: ['write'] as const,
    parameters: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        date: { type: 'string' as const, description: '月-日，如 10-01' },
        name: { type: 'string' as const, description: '这天是什么日子' },
      },
      required: ['date', 'name'] as const,
    },
  },
  {
    name: 'ritual_list',
    description: '列出记下的纪念日。',
    tags: ['read'] as const,
    parameters: { type: 'object' as const, additionalProperties: false, properties: {} },
  },
]

interface RitualData {
  anniversaries: Array<{ date: string; name: string }>
  lastMorning: string
  lastNight: string
  lastAnniversary: string
}

function normalizeDate(value: string): string | null {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(value)
  if (!match) return null
  const month = Number(match[1]), day = Number(match[2])
  const date = new Date(Date.UTC(2000, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0')
}

export class RitualWorld implements World {
  readonly id = 'ritual'
  private host: WorldHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly dataFile: string
  private data: RitualData
  private checking = false
  private generation = 0

  constructor(opts: { cfg: { morningAt: string; nightAt: string }; dataDir: string; timezone: string }) {
    this.morningAt = opts.cfg.morningAt
    this.nightAt = opts.cfg.nightAt
    this.timezone = opts.timezone
    this.dataFile = join(opts.dataDir, 'ritual.json')
    this.data = this.load()
  }

  private readonly morningAt: string
  private readonly nightAt: string
  private readonly timezone: string

  private load(): RitualData {
    try {
      if (existsSync(this.dataFile)) {
        const j = JSON.parse(readFileSync(this.dataFile, 'utf8')) as Partial<RitualData>
        const morning = typeof j.lastMorning === 'string' ? j.lastMorning : ''
        const legacy = /^(\d{4}-\d{2}-\d{2}):anniv:/.exec(morning)
        return {
          anniversaries: Array.isArray(j.anniversaries) ? j.anniversaries.flatMap(item => {
            const date = typeof item?.date === 'string' ? normalizeDate(item.date) : null
            return date && typeof item.name === 'string' && item.name.trim() ? [{ date, name: item.name.trim().slice(0, 200) }] : []
          }) : [],
          lastMorning: legacy?.[1] ?? morning,
          lastNight: typeof j.lastNight === 'string' ? j.lastNight : '',
          lastAnniversary: typeof j.lastAnniversary === 'string' ? j.lastAnniversary : legacy?.[1] ?? '',
        }
      }
    } catch { /* 读坏了就当空的 */ }
    return { anniversaries: [], lastMorning: '', lastNight: '', lastAnniversary: '' }
  }

  private save(next: RitualData): void {
    mkdirSync(dirname(this.dataFile), { recursive: true })
    const temporary = this.dataFile + '.tmp'
    writeFileSync(temporary, JSON.stringify(next, null, 2))
    renameSync(temporary, this.dataFile)
    this.data = next
  }

  envPromptVars(): Record<string, string> {
    return {}
  }

  tools(): ToolDef[] {
    return [
      {
        ...RITUAL_TOOL_DECLS[0],
        tags: [...RITUAL_TOOL_DECLS[0].tags],
        handler: async (args: Record<string, unknown>) => {
          const date = normalizeDate(String(args.date ?? '').trim())
          const name = String(args.name ?? '').trim()
          if (!date || !name || name.length > 200) return '格式不对：date 要有效的「月-日」（允许 02-29），name 为 1 到 200 字。'
          this.save({ ...this.data, anniversaries: [...this.data.anniversaries.filter((a) => a.date !== date), { date, name }] })
          return '记下了：' + date + ' ' + name + '。'
        },
      },
      {
        ...RITUAL_TOOL_DECLS[1],
        tags: [...RITUAL_TOOL_DECLS[1].tags],
        handler: async () => {
          if (!this.data.anniversaries.length) return '还没有记过纪念日。'
          return this.data.anniversaries.map((a) => a.date + ' ' + a.name).join('\n')
        },
      },
    ]
  }

  webUi() {
    return autoWebUi('ritual', '仪式感', RITUAL_DEFAULTS)
  }
  async start(host: WorldHost): Promise<void> {
    this.generation++
    this.host = host
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => { void this.check().catch(error => host.log.warn('仪式提醒失败：' + String(error))) }, 60_000)
    this.timer.unref?.()
    try { await this.check() } catch (error) { await this.stop(); throw error }
  }

  async stop(): Promise<void> {
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.host = null
  }

  private async check(): Promise<void> {
    const host = this.host
    const generation = this.generation
    if (!host || this.checking) return
    this.checking = true
    try {
    const now = new Date()
    const hhmm = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: this.timezone }).slice(0, 5)
    const day = now.toLocaleDateString('en-CA', { timeZone: this.timezone })
    const monthDay = day.slice(5)
    const ts = nowIso(this.timezone)

    if (hhmm === this.morningAt && this.data.lastMorning !== day) {
      await host.pushEvent({ type: 'ritual.morning', ts, source: this.id, senderKey: this.id, origin: 'internal', text: '已到配置的早间提醒时间。' }, { trigger: 'piggyback' })
      this.save({ ...this.data, lastMorning: day })
    }
    if (this.host !== host || generation !== this.generation) return
    if (hhmm === this.nightAt && this.data.lastNight !== day) {
      await host.pushEvent({ type: 'ritual.night', ts, source: this.id, senderKey: this.id, origin: 'internal', text: '已到配置的晚间提醒时间。' }, { trigger: 'piggyback' })
      this.save({ ...this.data, lastNight: day })
    }
    if (this.host !== host || generation !== this.generation) return
    const hit = this.data.anniversaries.find((a) => a.date === monthDay)
    if (hit && this.data.lastAnniversary !== day) {
      // Registered names are source material, even after they were saved locally.
      await host.pushEvent({ type: 'ritual.anniversary', ts, source: this.id, senderKey: this.id, origin: 'external', text: '已到你登记的纪念日「' + hit.name + '」。', meta: { name: hit.name, date: hit.date } }, { trigger: 'piggyback' })
      this.save({ ...this.data, lastAnniversary: day })
    }
    } finally { this.checking = false }
  }
}
