/**
 * 钟点与时段。全是纯函数，测起来不用等时间。
 *
 * 分时段不是为了替谁决定做什么，只是把人看钟点时会顺手做的那层解释补上：
 * 「23:40」是数字，「深夜」才是"该睡了"。
 */

/** 时段名。0 点算深夜 —— 23:00–01:00 是一整段。 */
export type PeriodName = '凌晨' | '清晨' | '上午' | '中午' | '下午' | '傍晚' | '晚上' | '深夜'

/**
 * 各时段的起点（小时）。**必须按小时升序**，`periodOf` 靠"最后一个起点不大于此刻的"来判。
 * 0 点没有条目，它落回默认的「深夜」，和 23 点连成一段。
 */
export const PERIOD_STARTS: ReadonlyArray<{ name: PeriodName; from: number }> = [
  { name: '凌晨', from: 1 },
  { name: '清晨', from: 5 },
  { name: '上午', from: 8 },
  { name: '中午', from: 11 },
  { name: '下午', from: 13 },
  { name: '傍晚', from: 17 },
  { name: '晚上', from: 19 },
  { name: '深夜', from: 23 },
]

/** 这一小时属于哪个时段。 */
export function periodOf(hour: number): PeriodName {
  let name: PeriodName = '深夜'
  for (const p of PERIOD_STARTS) {
    if (hour >= p.from) name = p.name
  }
  return name
}

/** 这个点通常意味着什么。一句话，说的是钟点本身，不替谁决定该干什么。 */
export const PERIOD_NOTES: Readonly<Record<PeriodName, string>> = {
  凌晨: '一天里最安静的一段，人通常已经睡了；还没睡就是熬过头了。',
  清晨: '天刚亮，多数人还在睡。',
  上午: '白天的正事时间，人可能不在。',
  中午: '饭点。',
  下午: '白天的正事时间，人可能不在。',
  傍晚: '收工前后。',
  晚上: '一天里最闲的一段，人通常在。',
  深夜: '该睡了。',
}

/** `2026-09-21T13:24:00+08:00` → `9月21日`。 */
export function chineseDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  if (!y || !m || !d) return iso.slice(0, 10)
  return `${Number(m)}月${Number(d)}日`
}

/** `2026-09-21T13:24:00+08:00` → `13:24`。 */
export function clockOf(iso: string): string {
  return iso.slice(11, 16)
}

/** 一天的进度：已经过去多少分钟、还剩多少分钟。用于"今天还剩几小时"这类说法。 */
export function dayProgress(iso: string): { passedMinutes: number; leftMinutes: number } {
  const [h, m] = [Number(iso.slice(11, 13)), Number(iso.slice(14, 16))]
  const passed = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
  return { passedMinutes: passed, leftMinutes: Math.max(0, 1440 - passed) }
}

/** 分钟数说成人话：95 → `1 小时 35 分`。 */
export function humanMinutes(total: number): string {
  const m = Math.max(0, Math.round(total))
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rest = m - h * 60
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`
}

/**
 * 一整行钟点：`9月21日 13:24 周一，下午`。
 *
 * 星期由调用方算好传进来（要 Intl 和时区），这里保持纯函数。
 */
export function clockLine(iso: string, weekday: string): string {
  const period = periodOf(Number(iso.slice(11, 13)))
  return `${chineseDate(iso)} ${clockOf(iso)} ${weekday}，${period}`
}
