import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TodoWorld } from '../../packages/cortico-world-todo-alont1/src/world.ts'
import { WorksWorld } from '../../packages/cortico-world-works-alont1/src/world.ts'

for (const kind of ['todo', 'works'] as const) {
  test(`${kind} commits persisted changes and rejects failed writes without changing the list`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'cortico-storage-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const dataDir = join(dir, 'data')
    const world = kind === 'todo' ? new TodoWorld({ dataDir }) : new WorksWorld({ dataDir, botDir: dir })
    const tools = world.tools()
    const call = (name: string, args = {}) => tools.find(tool => tool.name === `${kind}_${name}`)!.handler(args, {} as never)
    const input = kind === 'todo' ? { text: 'persisted' } : { title: 'persisted' }
    assert.match(String(await call('add', input)), /#1/)
    const file = join(dataDir, `${kind}.json`)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1)
    rmSync(file)
    mkdirSync(file)
    assert.match(String(await call('add', kind === 'todo' ? { text: 'rejected' } : { title: 'rejected' })), /保存失败/)
    assert.doesNotMatch(String(await call('list')), /rejected/)
    if (kind === 'todo') {
      assert.match(String(await call('done', { id: 1 })), /保存失败/)
      assert.match(String(await call('list')), /\[ \] #1/)
      assert.match(String(await call('remove', { id: 1 })), /保存失败/)
      assert.match(String(await call('list')), /persisted/)
    }
  })
  test(`${kind} preserves unreadable existing state instead of resetting it`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'cortico-invalid-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, `${kind}.json`)
    writeFileSync(file, '{broken')
    assert.throws(() => kind === 'todo' ? new TodoWorld({ dataDir: dir }) : new WorksWorld({ dataDir: dir, botDir: dir }))
    assert.equal(readFileSync(file, 'utf8'), '{broken')
  })
}
