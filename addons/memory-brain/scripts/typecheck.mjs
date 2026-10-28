import { spawnSync } from 'node:child_process'
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false'], { stdio: 'inherit', cwd: new URL('../', import.meta.url) })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
