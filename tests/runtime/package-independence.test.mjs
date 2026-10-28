import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dependencyProblems } from '../../scripts/dependencies.mjs'

function fixture(t, source, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'extension-dependencies-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'package'); mkdirSync(dir)
  writeFileSync(join(dir, 'index.ts'), source)
  writeFileSync(join(dir, 'local.ts'), 'export const x = 1')
  writeFileSync(join(root, 'outside.ts'), 'export const x = 1')
  return dependencyProblems(dir, { name: 'cortico-world-fixture', ...extra })
}
test('single-package audit accepts its own files and the host SDK', t => {
  assert.deepEqual(fixture(t, "import type { World } from 'cortico/core/types.ts'; import './local.ts'; import 'node:fs'"), [])
})
test('single-package audit rejects escapes even when the sibling file exists', t => {
  assert.match(fixture(t, "export { x } from '../outside.ts'").join('\n'), /leaves package/)
})
test('single-package audit rejects omitted files and absolute machine paths', t => {
  const errors = fixture(t, "import './missing.ts'; import 'file:///C:/private/module.ts'")
  assert.ok(errors.some(error => error.includes('Missing packaged')))
  assert.ok(errors.some(error => error.includes('Non-portable')))
})
test('optional peers and type imports cannot hide other extensions', t => {
  const errors = fixture(t, "import type { Value } from 'cortico-world-other';", { optionalDependencies: { 'cortico-world-other': '^1.0.0' }, dependencies: { helper: 'file:../helper' } })
  assert.ok(errors.some(error => error.includes('Cross-extension dependency')))
  assert.ok(errors.some(error => error.includes('Cross-extension import')))
  assert.ok(errors.some(error => error.includes('Local workspace dependency')))
})
test('template and inline type imports are checked while computed imports require review', t => {
  const errors = fixture(t, "await import(`../outside.ts`); const path='./local.ts'; await import(path); type Value = import('cortico-world-other').Value;")
  assert.ok(errors.some(error => error.includes('Relative import leaves package')))
  assert.ok(errors.some(error => error.includes('Dynamic import needs explicit isolation review')))
  assert.ok(errors.some(error => error.includes('Cross-extension import')))
})

test('npm aliases cannot hide cross-extension dependencies behind permitted or optional names', t => {
  for (const [field, name, target] of [['dependencies', 'ws', 'cortico-world-other'], ['optionalDependencies', 'helper', '@owner/cortico-world-other']]) {
    const errors = fixture(t, "export const value = 1", { name: 'cortico-world-qq-better-alont1', [field]: { [name]: `npm:${target}@^1.0.0` } })
    assert.ok(errors.some(error => error.includes('Cross-extension alias')), errors.join('\n'))
  }
  assert.deepEqual(fixture(t, "import 'ws'", { name: 'cortico-world-qq-better-alont1', dependencies: { ws: 'npm:ws@^8.0.0' } }), [])
})

test('external import-equals checks cross-extension and relative targets', t => {
  const errors = fixture(t, "import other = require('cortico-world-other'); import outside = require('../outside.ts');")
  assert.ok(errors.some(error => error.includes('Cross-extension import')))
  assert.ok(errors.some(error => error.includes('Relative import leaves package')))
})

test('named type-only imports and exports do not require a runtime dependency but mixed imports do', t => {
  assert.deepEqual(fixture(t, "import { type Value } from 'compile-only-types'; export { type Another } from 'compile-only-types';", { devDependencies: { 'compile-only-types': '^1.0.0' } }), [])
  for (const source of ["import Default, { type Value } from 'compile-only-types'", "import { type Value, runtime } from 'compile-only-types'", "export { type Value, runtime } from 'compile-only-types'"]) {
    assert.ok(fixture(t, source).some(error => error.includes('Undeclared runtime import')))
  }
})
