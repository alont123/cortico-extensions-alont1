/**
 * 写入：**先备份，再只改该改的**。
 *
 * 两条红线：
 *   · 只收紧（`auto` 且判定不合规的才动），绝不放宽；
 *   · 原文件先按时间戳备份一份，出问题能原样放回。
 *
 * 改的是 config.json 里的值。框架读配置的时机分两种：标了「热生效」的键改完就生效，
 * 其余要重启那个 World（不用重启整个进程）。
 */
import { constants, copyFileSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { checkRules, setPath, targetValue } from './check.mjs'
import { parseJson } from './json.mjs'

export function applyFixes(file, results, { apply = false, stamp = new Date() } = {}) {
  const raw = readFileSync(file, 'utf8')
  const config = parseJson(raw)
  const currentResults = checkRules(config, results.map((r) => r.rule))
  const planned = currentResults.filter((r) => r.verdict !== 'ok' && r.rule.auto !== false && r.rule.report !== true)
  const skipped = currentResults.filter((r) => r.verdict !== 'ok' && (r.rule.auto === false || r.rule.report === true))
  if (!planned.length) return { changed: [], skipped, backup: null, written: false }
  const changed = []
  for (const { rule, current } of planned) {
    const next = targetValue(rule)
    setPath(config, rule.path, next)
    changed.push({ path: rule.path, from: current, to: next, title: rule.title })
  }

  if (!apply) return { changed, skipped, backup: null, written: false }

  if (lstatSync(file).isSymbolicLink()) throw new Error('配置文件是链接，请明确选择普通配置文件后操作')
  const suffix = `${formatStamp(stamp)}-${randomUUID()}`
  const backup = `${file}.bak-frugal-${suffix}`
  const temporary = `${file}.tmp-frugal-${suffix}`
  copyFileSync(file, backup, constants.COPYFILE_EXCL)
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: lstatSync(file).mode })
    if (readFileSync(file, 'utf8') !== raw) throw new Error('配置已被其他程序修改，本次未覆盖；请重新检查')
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
  return { changed, skipped, backup, written: true }
}

function formatStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
