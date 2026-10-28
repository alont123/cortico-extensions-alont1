/**
 * 账本画像：`<部署>/data/usage.jsonl` 一行一次请求。
 *
 * 只读它，不改。要回答的是三个问题：
 *   1. 一天几次请求（次数 × 前缀 = 账单的大头）；
 *   2. 输入里缓存命中多少（命中便宜十倍，但量大照样是大头）；
 *   3. **前缀换过几次**（`prefixHash` 一变，缓存全废，那一次等于全价重发）——
 *      这一项最容易被忽略，也最容易改好（少改提示词）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function readUsage(deploymentDir, days = 1) {
  const file = join(deploymentDir, 'data', 'usage.jsonl')
  const empty = {
    file, exists: false, requests: 0, promptTokens: 0, cachedTokens: 0, uncachedTokens: 0,
    outputTokens: 0, reasoningTokens: 0, prefixHashes: 0, prefixSwitches: 0,
    byHour: new Map(), byModel: new Map(), firstTs: null, lastTs: null, failed: 0,
  }
  if (!existsSync(file)) return empty

  const from = Date.now() - days * 86_400_000
  const out = { ...empty, exists: true, byHour: new Map(), byModel: new Map() }
  const seenPrefix = new Set()
  let lastPrefix = null

  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    out.exists = false
    return out
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    const at = Date.parse(r.ts ?? '')
    if (!Number.isFinite(at) || at < from) continue

    out.requests += 1
    const input = Number(r.promptTokens ?? 0)
    const cached = Number(r.cacheHitTokens ?? 0)
    out.promptTokens += input
    out.cachedTokens += cached
    out.uncachedTokens += Math.max(0, Number(r.cacheMissTokens ?? input - cached))
    out.outputTokens += Number(r.completionTokens ?? 0)
    out.reasoningTokens += Number(r.reasoningTokens ?? 0)
    if (Number(r.status ?? 200) >= 400) out.failed += 1

    const hour = new Date(at).getHours()
    out.byHour.set(hour, (out.byHour.get(hour) ?? 0) + 1)
    const model = String(r.model ?? '?')
    out.byModel.set(model, (out.byModel.get(model) ?? 0) + 1)

    const hash = r.prefixHash
    if (typeof hash === 'string' && hash) {
      seenPrefix.add(hash)
      if (lastPrefix !== null && hash !== lastPrefix) out.prefixSwitches += 1
      lastPrefix = hash
    }

    const ts = r.ts
    if (!out.firstTs || ts < out.firstTs) out.firstTs = ts
    if (!out.lastTs || ts > out.lastTs) out.lastTs = ts
  }
  out.prefixHashes = seenPrefix.size
  return out
}

/** 人话：把 token 数说成 k / M。 */
export function humanTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** 记忆/前缀那几份文件有多大 —— 它们是每一轮都要重发的那部分。 */
export function prefixSizes(deploymentDir) {
  const ws = join(deploymentDir, 'workspace')
  const files = ['CONSTITUTION.md', 'MEMORY.md', 'RECENT.md']
  const out = []
  for (const name of files) {
    const file = join(ws, name)
    if (!existsSync(file)) continue
    try {
      out.push({ name, chars: readFileSync(file, 'utf8').length })
    } catch { /* 读不到就不报 */ }
  }
  return out
}
