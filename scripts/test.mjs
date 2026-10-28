import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? collect(join(dir, entry.name)) : /\.test\.(ts|mjs)$/.test(entry.name) ? [join(dir, entry.name)] : [])
}
const files = [...collect(join(root, 'tests')), ...collect(join(root, 'packages/cortico-frugal-alont1/tests'))]
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
