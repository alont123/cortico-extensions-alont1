import { register } from 'tsx/esm/api'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkDifferences } from './baseline.mjs'
import { dependencyProblems } from './dependencies.mjs'

register()
const { parseExtensionManifest } = await import('cortico/extensions/manifest.ts')
const { dryMountBot, dryMountWorld } = await import('cortico/extensions/dry-mount.ts')
const { checkDescribe } = await import('cortico/extensions/describe-export.ts')
const root = fileURLToPath(new URL('../', import.meta.url))
const changes = checkDifferences()
mkdirSync(join(root, 'scratch'), { recursive: true })
const scratch = mkdtempSync(join(root, 'scratch', 'packages-'))
const results = []
try {
  for (const name of readdirSync(join(root, 'packages')).sort()) {
    const dir = join(root, 'packages', name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const result = { name, version: manifest.version, ok: [], warnings: [], failures: [] }
    result.failures.push(...dependencyProblems(dir, manifest))
    if (name !== manifest.name) result.failures.push('package directory and published name differ')
    if (manifest.cortico) {
      const parsed = parseExtensionManifest(manifest)
      result.warnings.push(...parsed.warnings)
      if (!parsed.ok) result.failures.push(...parsed.reasons)
      for (const key of ['describe', 'webUiClient', 'webUiStyle']) {
        if (manifest.cortico[key] && !existsSync(join(dir, manifest.cortico[key]))) result.failures.push(`missing cortico.${key}: ${manifest.cortico[key]}`)
      }
      try {
        const definition = (await import(pathToFileURL(join(dir, manifest.main)).href)).default
        const opts = { scratchDir: join(scratch, name), packageDir: dir, hasWebUiClient: !!manifest.cortico.webUiClient }
        const report = manifest.cortico.kind === 'world' ? await dryMountWorld(definition, opts) : dryMountBot(definition, opts)
        const described = await checkDescribe(manifest.cortico.kind, definition, manifest.cortico.describe, opts)
        report.ok.push(...described.ok)
        report.warnings.push(...described.warnings)
        report.failures.push(...described.failures)
        result.ok.push(...report.ok)
        result.warnings.push(...report.warnings)
        result.failures.push(...report.failures)
      } catch (error) { result.failures.push(String(error)) }
    } else {
      const cli = spawnSync(process.execPath, [join(dir, 'bin/cortico-frugal.mjs'), '--help'], { encoding: 'utf8', timeout: 10000 })
      if (cli.status !== 0) result.failures.push('CLI --help failed')
      else result.ok.push('CLI --help works')
    }
    results.push(result)
    console.log(`${result.failures.length ? 'FAIL' : 'PASS'} ${name}@${manifest.version}${result.warnings.length ? ` (${result.warnings.length} warnings)` : ''}`)
    for (const failure of result.failures) console.log('  ' + failure)
  }
} finally { rmSync(scratch, { recursive: true, force: true }) }
mkdirSync(join(root, 'reports'), { recursive: true })
writeFileSync(join(root, 'reports', 'packages.json'), JSON.stringify(results, null, 2) + '\n')
console.log(`Baseline preserved; ${changes.length} reviewed differences in ${new Set(changes.map(change => change.package)).size} packages`)
process.exitCode = results.some(result => result.failures.length) ? 1 : 0
