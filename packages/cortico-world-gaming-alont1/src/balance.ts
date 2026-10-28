/**
 * 看图工具的"耐久度"：查询 DeepSeek 账户余额，余额越低耐久度越低。
 *
 * 走官方 `GET /user/balance`（OpenAI 风格 Bearer 鉴权），和看画面用的是同一把密钥。
 * 纯只读；查不到就安静返回 null，不影响看画面本身。
 */
export interface BalanceInfo {
  available: boolean
  currency: string
  total: number
  granted: number
  toppedUp: number
  at: number
}

export interface BalanceQueryOptions {
  baseUrl: string
  apiKey: string
  timeoutMs: number
}

/** 把余额换算成 0–100 的"耐久度"：满格线是 full，低于 warnBelow 就掉到 20% 以下。 */
export function durabilityOf(total: number, full: number): number {
  if (!(full > 0) || !Number.isFinite(total)) return 0
  return Math.max(0, Math.min(100, Math.round((total / full) * 100)))
}

export async function fetchBalance(opts: BalanceQueryOptions): Promise<BalanceInfo | null> {
  if (!opts.apiKey) return null
  try {
    const res = await fetch(opts.baseUrl.replace(/\/+$/, '') + '/user/balance', {
      headers: { authorization: 'Bearer ' + opts.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { is_available?: boolean; balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }> }
    const info = j.balance_infos?.[0]
    if (!info) return null
    return {
      available: j.is_available === true,
      currency: String(info.currency ?? 'CNY'),
      total: Number(info.total_balance ?? '0') || 0,
      granted: Number(info.granted_balance ?? '0') || 0,
      toppedUp: Number(info.topped_up_balance ?? '0') || 0,
      at: Date.now(),
    }
  } catch {
    return null
  }
}
