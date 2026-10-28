#!/usr/bin/env node
/**
 * cortico-frugal —— Cortico bot 省 token 体检。
 *
 *   npx cortico-frugal                      # 只看：账本画像 + 配置体检（不改任何东西）
 *   npx cortico-frugal --days 7             # 账本看最近 7 天
 *   npx cortico-frugal --repo D:\...        # 指定 checkout
 *   npx cortico-frugal --deployment mybot   # 指定部署（有多个部署时）
 *   npx cortico-frugal --apply              # 真的改（只收紧、先备份、改完打印明细）
 *   npx cortico-frugal --json               # 机器可读
 *
 * 零依赖，只读配置与账本；--apply 也只改那些「越贵越亏」的键，从不放宽任何上限。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findDeployment, findProvider, findRepo } from '../src/find.mjs'
import { prefixSizes, readUsage } from '../src/usage.mjs'
import { checkRules } from '../src/check.mjs'
import { applyFixes } from '../src/apply.mjs'
import { PROVIDER_RULES, RULES } from '../src/rules.mjs'
import { render } from '../src/report.mjs'
import { readJson } from '../src/json.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

/**
 * 控制台端口：部署配置里可能没有 `web` 段（端口写在 bot 包里的 `web: { port: N }`）。
 * 只为了在报告末尾多打一行链接，读不到就返回 null —— 读 TS 用正则，够用就行。
 */
function consolePort(repo, deploymentDir, config) {
  const direct = config?.web?.port ?? config?.core?.port
  if (Number.isInteger(direct)) return direct
  try {
    const bot = readJson(join(deploymentDir, 'deployment.json')).bot
    const index = join(repo, 'bots', String(bot), 'index.ts')
    if (!existsSync(index)) return null
    const hit = /web:\s*\{[^}]*port:\s*(\d+)/s.exec(readFileSync(index, 'utf8'))
    return hit ? Number(hit[1]) : null
  } catch {
    return null
  }
}

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(new URL('../README.md', import.meta.url), 'utf8'))
  process.exit(0)
}

try {
  const repo = findRepo(process.cwd(), value('--repo', null))
  const deployment = findDeployment(repo, value('--deployment', null))
  const days = Number(value('--days', '1'))
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error('--days 必须大于 0 且不超过 3650')

  const configFile = join(deployment.dir, 'config.json')
  const config = readJson(configFile)
  const usage = readUsage(deployment.dir, days)
  const sizes = prefixSizes(deployment.dir)

  const configResults = checkRules(config, RULES)
  const provider = findProvider(repo, deployment.dir, config.activeProvider)
  let providerResults = []
  let applied = { changed: [], skipped: [], backup: null, written: false }

  if (provider && existsSync(provider.file)) {
    const providerConfig = readJson(provider.file)
    providerResults = checkRules(providerConfig, PROVIDER_RULES)
    if (flag('--apply')) {
      const res = applyFixes(provider.file, providerResults, { apply: true })
      providerResults = checkRules(readJson(provider.file), PROVIDER_RULES)
      applied = { ...res, changed: [...applied.changed, ...res.changed] }
    }
  }

  if (flag('--apply')) {
    const res = applyFixes(configFile, configResults, { apply: true })
    applied = {
      changed: [...applied.changed, ...res.changed],
      skipped: res.skipped,
      backup: res.backup ?? applied.backup,
      written: applied.written || res.written,
    }
    // 改完重新读一遍，报告里显示的就是改完之后的状态
    configResults.length = 0
    configResults.push(...checkRules(readJson(configFile), RULES))
  }

  const port = consolePort(repo, deployment.dir, config)
  const prefix = port ? `http://127.0.0.1:${port}/` : null

  if (flag('--json')) {
    console.log(JSON.stringify({
      repo, deployment: deployment.name, days,
      usage: { ...usage, byHour: Object.fromEntries(usage.byHour), byModel: Object.fromEntries(usage.byModel) },
      sizes,
      config: configResults.map((r) => ({ path: r.rule.path, current: r.current ?? null, verdict: r.verdict, suggest: r.rule.suggest ?? null })),
      provider: providerResults.map((r) => ({ path: r.rule.path, current: r.current ?? null, verdict: r.verdict, suggest: r.rule.suggest ?? null })),
      applied,
    }, null, 2))
    process.exit(0)
  }

  console.log(render({ repo, deployment: deployment.name, days, usage, sizes, configResults, providerResults, applied, prefix }))
} catch (err) {
  console.error(`cortico-frugal: ${err?.message ?? err}`)
  process.exit(1)
}
