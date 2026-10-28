import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PlaygroundWorld } from '../../packages/cortico-world-playground-alont1/src/world.ts'

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-play-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const world = new PlaygroundWorld({ botDir: dir, cfg: { timeoutSec: 1 } })
  return (code: string) => world.tools()[0].handler({ code }, {} as never)
}
test('playground retains console output, completion values and guest standard objects', async t => {
  const run = fixture(t)
  assert.match(String(await run('console.log(Math.max(2, 3), 1n); 2 + 2')), /3 1n\n返回值：4/)
  assert.match(String(await run('console.log(typeof process, typeof require, typeof fetch)')), /undefined undefined undefined/)
})
test('playground constructors cannot access the host process', async t => {
  const run = fixture(t)
  for (const code of ["Object.constructor('return process')()", "console.log.constructor('return process')()", "this.constructor.constructor('return process')()"]) {
    assert.match(String(await run(code)), /跑挂了/)
  }
})
test('playground times out guest serialization and async microtasks', async t => {
  const run = fixture(t)
  assert.match(String(await run('({ toJSON() { while (true) {} } })')), /跑挂了/)
  assert.match(String(await run('Promise.resolve().then(() => { while (true) {} })')), /跑挂了/)
  assert.match(String(await run('throw new Proxy({}, { getPrototypeOf() { while(true) {} } })')), /跑挂了/)
})
