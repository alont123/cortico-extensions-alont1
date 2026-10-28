import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { exportDescribe } from 'cortico/extensions/describe-export.ts'
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts'
import definition from '../src/index.ts'
mkdirSync('scratch', { recursive: true })
const scratch = mkdtempSync(resolve('scratch/describe-'))
try {
  const options = { scratchDir: scratch, packageDir: resolve('.') }
  const report = await dryMountWorld(definition, options)
  if (report.failures.length) throw new Error(report.failures.join('\n'))
  console.log('Contract dry mount: ' + report.ok.length + ' checks; ' + report.warnings.length + ' warnings')
  const description = await exportDescribe('world', definition, options)
  writeFileSync('describe.json', JSON.stringify(description, null, 2) + '\n')
  console.log('describe.json: ' + description.tools.length + ' tools')
} finally { rmSync(scratch, { recursive: true, force: true }) }
