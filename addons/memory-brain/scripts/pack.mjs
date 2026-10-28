import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const result = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true', npm_config_cache: join(process.cwd(), 'scratch/npm-cache') } })
if (result.status !== 0) throw new Error(result.stderr)
const info = JSON.parse(result.stdout)[0]
const files = new Set(info.files.map(file => file.path))
for (const required of ['src/index.ts', 'src/panel.ts', 'src/ENV_PROMPT.md', 'describe.json', 'README.md']) if (!files.has(required)) throw new Error('Missing ' + required)
for (const file of files) if (/(^|\/)(node_modules|data|tests|scratch|reports|\.git)(\/|$)|\.db|\.env|\.corrupt|\.test\./.test(file)) throw new Error('Excluded file: ' + file)
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
if (Object.keys(manifest.dependencies ?? {}).length) throw new Error('Package must be runtime-dependency-free')
mkdirSync('reports', { recursive: true }); writeFileSync('reports/pack.json', JSON.stringify(info, null, 2) + '\n')
console.log(`${files.size} files; ${info.size} bytes; zero runtime dependencies; dry run passed`)
