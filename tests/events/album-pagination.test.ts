import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { JsonlEventStore } from 'cortico/core/event-store.ts'
import { nullLogger } from 'cortico/core/util.ts'
import type { WorldHost } from 'cortico/core/types.ts'
import { AlbumWorld } from '../../packages/cortico-world-album-alont1/src/world.ts'
import { ALBUM_DEFAULTS } from '../../packages/cortico-world-album-alont1/src/config.ts'

function fixture(t: test.TestContext) {
  const base = resolve('scratch'); mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'album-pagination-'))
  const store = new JsonlEventStore({ dataDir: dir, run: 'fixture', timezone: 'UTC' })
  let world: AlbumWorld | undefined
  t.after(async () => { await world?.stop(); assert.ok(dir.startsWith(base)); rmSync(dir, { recursive: true, force: true }) })
  function append(count: number) {
    for (let i = 0; i < count; i++) {
      const seq = store.latestCursor() + 1
      store.append({ type: 'qq.message', source: 'qq', origin: 'external', senderKey: '12345', text: '', ts: new Date(1700000000000 + seq).toISOString(), blobs: [{ handle: `log:image-${seq}`, mime: 'image/png', fallbackText: `fixture image ${seq}` }] })
    }
  }
  return { dir, store, append, data: () => JSON.parse(readFileSync(join(dir, 'album.json'), 'utf8')),
    async start() {
      world = new AlbumWorld({ cfg: { ...ALBUM_DEFAULTS, scanChunk: 200 }, dataDir: dir, botName: 'fixture', timezone: 'UTC' })
      await world.start({ store, log: nullLogger() } as unknown as WorldHost)
      return world
    },
  }
}

test('album forward pagination retains every image across more than one EventStore tail-limited page', async t => {
  const f = fixture(t); f.append(201)
  const world = await f.start()
  assert.equal(f.data().entries.length, 201)
  assert.ok(f.data().entries.some((entry: { handle: string }) => entry.handle === 'log:image-1'))
  f.append(201)
  await world.tools().find(tool => tool.name === 'album_scan')!.handler({}, {} as never)
  assert.equal(f.data().entries.length, 402)
  assert.equal(f.data().scannedCursor, f.store.latestCursor())
})

test('album all-rescan and sender repair reach early events even when the saved cursor is already at the end', async t => {
  const f = fixture(t); f.append(201)
  writeFileSync(join(f.dir, 'album.json'), JSON.stringify({ version: 1, scannedCursor: f.store.latestCursor(), entries: [
    { id: 'legacy-first', handle: 'log:image-1', mime: 'image/png', at: new Date(1700000000001).toISOString(), from: 'me' },
  ] }))
  const world = await f.start()
  assert.equal(f.data().entries.find((entry: { id: string }) => entry.id === 'legacy-first').from, '12345')
  await world.tools().find(tool => tool.name === 'album_scan')!.handler({ all: true }, {} as never)
  assert.equal(new Set(f.data().entries.map((entry: { handle: string }) => entry.handle)).size, 201)
})
