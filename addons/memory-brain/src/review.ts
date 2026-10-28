import type { BrainDb, Row } from './db.ts'
import { hash } from './ingest.ts'

export function flag(db: BrainDb, options: { text?: string; chunk_id?: number; title?: string; tags?: string[] }, now = Date.now(), initialDays = 1): Row {
  const chunk = options.chunk_id === undefined ? undefined : db.get('SELECT c.*,d.source FROM chunks c JOIN documents d ON d.id=c.doc_id WHERE c.id=?', options.chunk_id)
  if (options.chunk_id !== undefined && !chunk) throw new Error('复习来源块不存在，请先重新检索')
  const text = (options.text?.trim() || chunk?.text || '').slice(0, 4000)
  if (!text) throw new Error('请提供 text 或有效 chunk_id')
  const digest = hash(JSON.stringify([text, chunk?.source ?? '']))
  db.transaction(() => {
    db.sql.prepare('INSERT INTO reviews(chunk_id,title,text,text_hash,due_at_ms,interval_days,source,tags_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(text_hash) DO NOTHING').run(chunk?.id ?? null, (options.title?.trim() || text).slice(0, 120), text, digest, now + initialDays * 86400000, initialDays, chunk ? chunk.source + ':' + chunk.start_line : null, JSON.stringify(options.tags ?? []), now)
  })
  return db.get('SELECT * FROM reviews WHERE text_hash=?', digest)!
}
export function due(db: BrainDb, limit = 5, now = Date.now()): Row[] { return db.all('SELECT * FROM reviews WHERE due_at_ms<=? ORDER BY due_at_ms,id LIMIT ?', now, limit) }
export function grade(db: BrainDb, id: number, value: number, now = Date.now()): Row {
  if (!Number.isInteger(value) || value < 0 || value > 3) throw new Error('grade 必须是 0–3 的整数')
  return db.transaction(() => {
    const item = db.get('SELECT * FROM reviews WHERE id=?', id)
    if (!item) throw new Error('复习条目不存在，请先 brain_review')
    if (item.last_grade === value && item.due_at_ms > now) return item
    const lapse = value < 2
    const interval = lapse ? 1 : Math.min(365, Math.max(1, Math.round(item.interval_days * (value === 2 ? 1.5 : item.ease))))
    const ease = lapse ? Math.max(1.3, item.ease - 0.3) : Math.min(5, item.ease + (value === 3 ? 0.1 : 0))
    db.sql.prepare('UPDATE reviews SET interval_days=?,ease=?,due_at_ms=?,reps=reps+1,lapses=lapses+?,last_grade=? WHERE id=?').run(interval, ease, now + interval * 86400000, Number(lapse), value, id)
    return db.get('SELECT * FROM reviews WHERE id=?', id)!
  })
}
