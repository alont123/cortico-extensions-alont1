/** 将面板契约与逐包中文教程复制进各独立包，不引入跨包运行依赖。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const template = readFileSync(join(root, 'templates/panel-runtime.ts'), 'utf8')
const guides = JSON.parse(readFileSync(join(root, 'docs/panel-guides.json'), 'utf8'))
const check = process.argv.includes('--check')
let count = 0, drift = 0
for (const name of readdirSync(join(root, 'packages')).sort()) {
  if (!name.startsWith('cortico-world-')) continue
  const key = name.slice('cortico-world-'.length, -'-alont1'.length)
  const guide = guides[key]
  if (!guide) throw new Error('Missing Chinese usage guide: ' + name)
  for (const [file, expected] of [['panel-runtime.ts', template], ['panel-guide.ts', `import type { PanelGuide } from './panel-runtime.ts'\nexport const PANEL_GUIDE: PanelGuide = ${JSON.stringify(guide, null, 2)}\n`]]) {
    const target = join(root, 'packages', name, 'src', file)
    let current
    try { current = readFileSync(target, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (current !== expected) {
      drift++
      if (check) console.error('Panel runtime differs: ' + name + '/' + file)
      else writeFileSync(target, expected)
    }
  }
  count++
}
console.log(`${count} world panel runtimes ${check ? 'checked' : 'synced'}; ${drift} ${check ? 'differences' : 'files updated'}`)
if (check && drift) process.exitCode = 1
