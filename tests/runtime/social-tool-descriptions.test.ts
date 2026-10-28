import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AFFINITY } from '../../packages/cortico-world-affinity-alont1/src/definition.ts'
import { LIFE } from '../../packages/cortico-world-life-alont1/src/definition.ts'
import { GAMING } from '../../packages/cortico-world-gaming-alont1/src/definition.ts'

for (const definition of [AFFINITY, LIFE, GAMING]) {
  test(`${definition.id} default tool declarations match the callable tools`, async t => {
    const base = resolve('scratch'); mkdirSync(base, { recursive: true })
    const dir = mkdtempSync(join(base, 'social-tool-describe-'))
    const world = definition.create({ cfg: structuredClone(definition.defaults()), dataDir: dir, botDir: dir, timezone: 'UTC', secret: () => '' } as never)
    t.after(async () => { await world.stop(); assert.ok(dir.startsWith(base)); rmSync(dir, { recursive: true, force: true }) })
    for (const actual of world.tools()) {
      const declared = definition.describe!.tools!.find(tool => tool.name === actual.name)
      assert.ok(declared, actual.name)
      assert.equal(declared.description, actual.description, `${actual.name} description`)
      assert.deepEqual(declared.parameters, actual.parameters, `${actual.name} parameters`)
      assert.deepEqual(declared.tags, actual.tags, `${actual.name} tags`)
    }
  })
}
