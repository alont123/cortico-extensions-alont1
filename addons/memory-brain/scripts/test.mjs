import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const files = readdirSync(new URL('../tests/', import.meta.url)).filter(file => file.endsWith('.test.ts')).map(file => 'tests/' + file)
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit', cwd: new URL('../', import.meta.url), env: { ...process.env, NODE_NO_WARNINGS: '1' } })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
