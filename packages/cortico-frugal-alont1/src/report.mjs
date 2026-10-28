/**
 * 输出：先结论，再数字，最后才是明细。
 *
 * 给谁看：给"这孩子怎么这么费钱"的操作者看。所以第一屏必须是
 * 「一天几次请求 / 缓存命中多少 / 前缀换过几次」加一句"该动哪三处"。
 */
import { humanTokens } from './usage.mjs'

const LINE = '─'.repeat(64)

function pct(a, b) {
  if (!b) return '0%'
  return `${Math.round((a / b) * 100)}%`
}

export function usageSection(usage, days) {
  const out = []
  out.push(`账本画像（最近 ${days} 天${usage.exists ? '' : '：还没有账本'}）`)
  if (!usage.exists || usage.requests === 0) {
    out.push('  （data/usage.jsonl 里这段时间没有记录：要么刚起步，要么账本被清过）')
    return out
  }
  out.push(`  请求 ${usage.requests} 次${usage.failed ? `（其中失败 ${usage.failed} 次）` : ''}`)
  out.push(`  输入 ${humanTokens(usage.promptTokens)} token（缓存命中 ${humanTokens(usage.cachedTokens)} = ${pct(usage.cachedTokens, usage.promptTokens)}，未命中 ${humanTokens(usage.uncachedTokens)}）`)
  out.push(`  输出 ${humanTokens(usage.outputTokens)} token${usage.reasoningTokens ? `（其中思考 ${humanTokens(usage.reasoningTokens)}）` : ''}`)
  out.push(`  平均每次请求输入 ${humanTokens(Math.round(usage.promptTokens / usage.requests))} token —— 这就是每轮都要重发的那一坨`)
  out.push(`  前缀出现过 ${usage.prefixHashes} 种、中途换过 ${usage.prefixSwitches} 次` +
    (usage.prefixSwitches > 3 ? '（每换一次缓存全废，那一次按全价重算 —— 少改提示词能立刻省）' : '（很稳，挺好）'))

  const hours = [...usage.byHour.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (hours.length) {
    out.push(`  最忙的时段：${hours.map(([h, n]) => `${String(h).padStart(2, '0')} 点 ${n} 次`).join('、')}`)
  }
  const models = [...usage.byModel.entries()].sort((a, b) => b[1] - a[1])
  if (models.length) {
    out.push(`  模型分布：${models.map(([m, n]) => `${m} ${n} 次`).join('、')}`)
  }
  return out
}

export function prefixSection(sizes) {
  if (!sizes.length) return []
  const out = ['每轮都在重发的那几份（工作区里的记忆与前缀）']
  for (const s of sizes) {
    const warn = s.name === 'RECENT.md' && s.chars > 8000 ? '  ← 偏大，建议定期归并压缩'
      : s.name === 'MEMORY.md' && s.chars > 12000 ? '  ← 偏大，长期记忆也该压一压'
        : ''
    out.push(`  ${s.name.padEnd(18)} ${String(s.chars).padStart(6)} 字${warn}`)
  }
  return out
}

export function rulesSection(title, results) {
  if (!results.length) return []
  const off = results.filter((r) => r.verdict !== 'ok')
  const out = [title]
  if (!off.length) {
    out.push('  ✓ 都合规')
    return out
  }
  for (const { rule, current, verdict } of off) {
    const now = verdict === 'absent' ? '（没写，走框架默认）' : JSON.stringify(current)
    const want = rule.report ? '（这一项只报，不自动改）' : `→ 建议 ${JSON.stringify(rule.suggest ?? rule.value)}`
    out.push(`  · ${rule.path}`)
    out.push(`      现在 ${now} ${want}`)
    out.push(`      ${rule.title}：${rule.why}`)
  }
  return out
}

export function planSection(applied) {
  const { changed, skipped, backup, written } = applied
  const out = []
  if (!changed.length && !skipped.length) return out
  out.push(written ? '已经改了这些（原文件已备份）' : '没改任何东西，这是"如果加 --apply 会改的"')
  for (const c of changed) {
    out.push(`  ${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}   ${c.title}`)
  }
  for (const s of skipped) {
    out.push(`  （没动）${s.rule.path}：现在 ${JSON.stringify(s.current)} —— ${s.rule.why}`)
  }
  if (written && backup) out.push(`  备份：${backup}`)
  if (written) out.push('  生效：标了「热生效」的键改完就生效；其余重启那一个 World（不用重启整个进程）。')
  return out
}

export function render({ repo, deployment, days, usage, sizes, configResults, providerResults, applied, prefix }) {
  const out = []
  out.push(LINE)
  out.push('cortico-frugal · 省 token 体检')
  out.push(`  checkout ${repo}`)
  out.push(`  部署     ${deployment}`)
  out.push(LINE)
  out.push('')
  for (const l of usageSection(usage, days)) out.push(l)
  out.push('')
  for (const l of prefixSection(sizes)) out.push(l)
  out.push('')
  for (const l of rulesSection('配置体检（群里那套）', configResults)) out.push(l)
  out.push('')
  for (const l of rulesSection('端点体检', providerResults)) out.push(l)
  out.push('')
  for (const l of planSection(applied)) out.push(l)
  out.push('')
  out.push(LINE)
  const off = [...configResults, ...providerResults].filter((r) => r.verdict !== 'ok')
  out.push(off.length
    ? `一共 ${off.length} 处偏离建议。默认只看不改：确认没问题再加 --apply（只收紧、先备份）。`
    : '配置都合规。账单再降就要从"少改提示词、压缩 RECENT"这类习惯上抠了。')
  if (prefix) out.push(`控制台：${prefix}`)
  return out.join('\n')
}
