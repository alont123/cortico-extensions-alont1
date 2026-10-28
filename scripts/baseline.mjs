import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../', import.meta.url))
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
}
export function packageDifferences() {
  const baseline = JSON.parse(readFileSync(join(root, 'package-files-baseline.json'), 'utf8'))
  const differences = []
  for (const name of readdirSync(join(root, 'packages')).sort()) {
    if (!baseline[name]) throw new Error(`Package not present in npm baseline: ${name}`)
    const dir = join(root, 'packages', name)
    const current = Object.fromEntries(walk(dir).map(file => [relative(dir, file).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(file)).digest('hex')]))
    for (const file of [...new Set([...Object.keys(baseline[name]), ...Object.keys(current)])].sort()) {
      if (baseline[name][file] !== current[file]) differences.push({ package: name, path: file, before: baseline[name][file] ?? null, after: current[file] ?? null })
    }
  }
  for (const name of Object.keys(baseline)) if (!readdirSync(join(root, 'packages')).includes(name)) throw new Error(`Baseline package missing: ${name}`)
  return differences
}
export function checkDifferences() {
  const expected = JSON.parse(readFileSync(join(root, 'package-changes.json'), 'utf8'))
  const actual = packageDifferences()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Package contents differ from reviewed package-changes.json; inspect the diff before recording changes.')
  const manifestBaseline = JSON.parse(readFileSync(join(root, 'packages-baseline.json'), 'utf8'))
  for (const item of manifestBaseline) {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', item.name, 'package.json'), 'utf8'))
    if (manifest.name !== item.name || manifest.version !== item.version) throw new Error(`${item.name}: name/version differ from npm baseline; releases must use a separate candidate directory.`)
  }
  return actual
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const differences = packageDifferences()
  if (process.argv.includes('--record-reviewed')) writeFileSync(join(root, 'package-changes.json'), JSON.stringify(differences, null, 2) + '\n')
  else checkDifferences()
  console.log(`${differences.length} reviewed file changes in ${new Set(differences.map(item => item.package)).size} packages; npm baseline unchanged`)
}
