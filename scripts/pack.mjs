import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkDifferences } from './baseline.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
checkDifferences()
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
if (!existsSync(npmCli)) throw new Error('Run this command through npm run pack:all so npm_execpath identifies the npm CLI.')
const results = []
for (const name of readdirSync(join(root, 'packages')).sort()) {
  const dir = join(root, 'packages', name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, npm_config_cache: join(root, 'scratch/npm-cache'), npm_config_offline: 'true' },
  })
  if (packed.status !== 0) throw new Error(`${name}: npm pack failed: ${packed.stderr}`)
  const info = JSON.parse(packed.stdout)[0]
  const entries = new Set(info.files.map(file => file.path))
  const required = ['package.json', 'README.md', 'LICENSE', ...(manifest.main ? [manifest.main.replace(/^\.\//, '')] : ['bin/cortico-frugal.mjs'])]
  for (const key of ['describe', 'webUiClient', 'webUiStyle']) if (manifest.cortico?.[key]) required.push(manifest.cortico[key])
  if (existsSync(join(dir, 'src/panel.ts'))) required.push('src/panel.ts')
  if (manifest.cortico?.kind === 'world') required.push('src/panel-runtime.ts', 'src/panel-guide.ts')
  if (name === 'cortico-world-playground-alont1') required.push('src/runner.mjs')
  for (const file of required) if (!entries.has(file)) throw new Error(`${name}: tarball is missing ${file}`)
  for (const file of entries) {
    if (/(^|\/)(node_modules|tests?|data|scratch|deployments|\.git)(\/|$)|(^|\/)\.env(?:\.|$)|\.bak(?:[.-]|$)|\.tmp$|\.test\./i.test(file)) throw new Error(`${name}: excluded file would ship: ${file}`)
  }
  results.push({ name, version: manifest.version, bytes: info.size, unpackedBytes: info.unpackedSize, files: info.files.length, integrity: info.integrity })
  console.log(`PASS ${name}: ${info.files.length} files, ${info.size} bytes`)
}
mkdirSync(join(root, 'reports'), { recursive: true })
writeFileSync(join(root, 'reports/pack.json'), JSON.stringify(results, null, 2) + '\n')
console.log(`${results.length} packages packed successfully (dry run; no publication)`)
