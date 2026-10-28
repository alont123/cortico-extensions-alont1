/**
 * 这份包的行为契约（零依赖，node --test 直接跑）：
 *   · 判定：只收紧的语义要对（atLeast/atMost/isTrue/isFalse/oneOf）；
 *   · 写入：--apply 只改 auto 且不合规的，报告项绝不动；
 *   · 写入：先备份，且是"原文件 → 备份、新内容 → 原文件"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRules, getPath, setPath, targetValue } from '../src/check.mjs'
import { applyFixes } from '../src/apply.mjs'
import { RULES } from '../src/rules.mjs'

test('判定：atLeast / atMost / isTrue / isFalse', () => {
  const rules = [
    { path: 'a.x', kind: 'atLeast', value: 10, suggest: 20 },
    { path: 'a.y', kind: 'atMost', value: 10, suggest: 8 },
    { path: 'a.t', kind: 'isTrue', suggest: true },
    { path: 'a.f', kind: 'isFalse', suggest: false },
  ]
  const results = checkRules({ a: { x: 5, y: 30, t: false, f: true } }, rules)
  assert.deepEqual(results.map((r) => r.verdict), ['off', 'off', 'off', 'off'])
  const ok = checkRules({ a: { x: 10, y: 10, t: true, f: false } }, rules)
  assert.deepEqual(ok.map((r) => r.verdict), ['ok', 'ok', 'ok', 'ok'])
  // 缺键不算"合规"，也不算"必须改"：报出来让人自己看
  const absent = checkRules({ a: {} }, rules)
  assert.deepEqual(absent.map((r) => r.verdict), ['absent', 'absent', 'absent', 'absent'])
})

test('写入：只改 auto 且不合规的，report 项一动不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({ worlds: { qqbot: { proactive: { enabled: true, dailyQuota: 50 } } } }))

  const config = JSON.parse(readFileSync(file, 'utf8'))
  const results = checkRules(config, [
    ...RULES.filter((r) => r.path === 'worlds.qqbot.proactive.dailyQuota'),
    ...RULES.filter((r) => r.path === 'worlds.qqbot.proactive.enabled'),
  ])
  const plan = applyFixes(file, results, { apply: false })
  assert.equal(plan.changed.length, 1)
  assert.equal(plan.changed[0].path, 'worlds.qqbot.proactive.dailyQuota')
  assert.equal(plan.changed[0].to, 8)
  // 只看不改：文件没动
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).worlds.qqbot.proactive.dailyQuota, 50)

  const done = applyFixes(file, results, { apply: true, stamp: new Date('2026-09-28T12:00:00') })
  assert.equal(done.written, true)
  assert.match(done.backup, /config\.json\.bak-frugal-20260928-120000-[0-9a-f-]+$/)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).worlds.qqbot.proactive.dailyQuota, 8)
  assert.equal(JSON.parse(readFileSync(done.backup, 'utf8')).worlds.qqbot.proactive.dailyQuota, 50)
  // 报告项（enabled 那条是 report）绝不能被写
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).worlds.qqbot.proactive.enabled, true)
  rmSync(dir, { recursive: true, force: true })
})

test('写入：已经调好的配置一个字都不改', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-ok-'))
  const file = join(dir, 'config.json')
  // 按建议表自己造一份"已经调到位"的配置：每个 auto 规则都写成它的建议值
  const good = {}
  for (const rule of RULES) {
    if (rule.report) continue
    setPath(good, rule.path, rule.suggest ?? rule.value)
  }
  writeFileSync(file, JSON.stringify(good))
  const results = checkRules(good, RULES)
  assert.equal(results.filter((r) => r.verdict !== 'ok' && !r.rule.report).length, 0)
  const plan = applyFixes(file, results, { apply: true })
  assert.equal(plan.written, false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), good)
  rmSync(dir, { recursive: true, force: true })
})

test('写入：空配置只会被"收紧"，不会出现比建议更松的值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frugal-empty-'))
  const file = join(dir, 'config.json')
  writeFileSync(file, '{}')
  const plan = applyFixes(file, checkRules({}, RULES), { apply: true })
  assert.ok(plan.changed.length > 5, '空配置应该被填上一批建议值')
  const after = JSON.parse(readFileSync(file, 'utf8'))
  // 改完之后，所有 auto 规则都该判为合规
  const left = checkRules(after, RULES).filter((r) => r.verdict !== 'ok' && !r.rule.report)
  assert.deepEqual(left.map((r) => r.rule.path), [])
  rmSync(dir, { recursive: true, force: true })
})

test('取值/写值：路径读写要对', () => {
  const o = { a: { b: { c: 1 } } }
  assert.equal(getPath(o, 'a.b.c'), 1)
  setPath(o, 'a.b.c', 2)
  assert.equal(o.a.b.c, 2)
  setPath(o, 'a.x.y', 3)
  assert.equal(o.a.x.y, 3)
})

test('建议值：suggest 优先，缺了就按判定类型给', () => {
  assert.equal(targetValue({ kind: 'atLeast', value: 10, suggest: 20 }), 20)
  assert.equal(targetValue({ kind: 'isTrue' }), true)
  assert.equal(targetValue({ kind: 'isFalse' }), false)
})
