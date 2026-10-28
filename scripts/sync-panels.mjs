/** templates/auto-panel.ts 是各独立发布包 src/panel.ts 的唯一来源。 */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const template = await readFile(join(root, 'templates', 'auto-panel.ts'), 'utf8')
const check = process.argv.includes('--check')
let count = 0
let drift = 0
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const path = join(root, 'packages', entry.name, 'src', 'panel.ts')
  let current
  try { current = await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') continue
    throw error
  }
  count++
  if (current === template) continue
  drift++
  if (check) console.error('Panel differs: ' + entry.name)
  else await writeFile(path, template)
}
console.log(`${count} panel helpers ${check ? 'checked' : 'synced'}; ${drift} ${check ? 'differences' : 'updated'}.`)
if (check && drift) process.exitCode = 1
