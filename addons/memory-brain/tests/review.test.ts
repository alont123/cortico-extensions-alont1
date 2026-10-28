import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fixture } from './helpers.ts'
import { due, flag, grade } from '../src/review.ts'
import { audit, digest } from '../src/audit.ts'

test('manual flag is idempotent and first due date is one day later', t => {
  const f = fixture(t); const now = Date.now(); const row = flag(f.db, { text: '记住测试约定' }, now)
  assert.equal(flag(f.db, { text: '记住测试约定' }, now).id, row.id)
  assert.equal(row.due_at_ms, now + 86400000); assert.equal(due(f.db, 5, now).length, 0); assert.equal(due(f.db, 5, row.due_at_ms).length, 1)
})
test('flagged source snapshot survives source reindex and deletion', async t => {
  const f = fixture(t); f.write('MEMORY.md', '# 约定\n下周去远航基地'); await f.ingest.sync()
  const id = f.db.get('SELECT id FROM chunks')!.id; const row = flag(f.db, { chunk_id: id })
  rmSync(join(f.workspace, 'MEMORY.md')); await f.ingest.sync()
  const stored = f.db.get('SELECT * FROM reviews WHERE id=?', row.id)!
  assert.equal(stored.chunk_id, null); assert.match(stored.text, /远航基地/); assert.equal(stored.source, 'MEMORY.md:1')
})
for (const value of [0, 1, 2, 3]) test(`grade ${value} updates interval ease and lapses`, t => {
  const f = fixture(t); const now = Date.now(); const row = flag(f.db, { text: '测试条目' }, now)
  const result = grade(f.db, row.id, value, row.due_at_ms)
  assert.equal(result.lapses, value < 2 ? 1 : 0); assert.equal(result.interval_days, value < 2 ? 1 : 2)
  assert.ok(result.ease >= 1.3); assert.equal(result.due_at_ms, row.due_at_ms + result.interval_days * 86400000)
})
test('replayed grades are idempotent and successful intervals cap at 365', t => {
  const f = fixture(t); let row = flag(f.db, { text: '记忆条目' }); const now = row.due_at_ms
  row = grade(f.db, row.id, 3, now); assert.equal(grade(f.db, row.id, 3, now + 1).reps, 1)
  for (let i = 0; i < 15; i++) row = grade(f.db, row.id, 3, row.due_at_ms)
  assert.equal(row.interval_days, 365); assert.throws(() => grade(f.db, row.id, 4)); assert.throws(() => flag(f.db, { chunk_id: 999999 }))
})
test('audit reports duplicates stale dates orphans and long chunks without deleting', async t => {
  const f = fixture(t); f.write('MEMORY.md', '1999-01-01 曾经有个约定。'); f.write('notes/duplicate.md', '1999-01-01 曾经有个约定。'); await f.ingest.sync()
  rmSync(join(f.workspace, 'MEMORY.md'))
  f.db.sql.prepare('UPDATE chunks SET text=? WHERE id=(SELECT MAX(id) FROM chunks)').run('长'.repeat(2000))
  const before = f.db.get('SELECT COUNT(*) n FROM documents')!.n
  const report = audit(f.db, f.workspace, 1000, 180)
  assert.ok(report.duplicates.length); assert.ok(report.stale.length); assert.equal(report.orphans.length, 1); assert.equal(report.long.length, 1)
  assert.equal(f.db.get('SELECT COUNT(*) n FROM documents')!.n, before)
  assert.match(digest(f.db, f.workspace, 7, 1000, 180), /新增\/变更文档 2/)
})
