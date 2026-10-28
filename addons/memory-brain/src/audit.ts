import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { BrainDb, Row } from './db.ts'

export interface AuditResult { duplicates: Row[]; stale: Row[]; orphans: Row[]; long: Row[]; conflicts: Row[]; coverage: { approximateChunkLimit: number; staleChunkLimit: number; perCategoryLimit: number } }
export function audit(db: BrainDb, workspace: string, maxChars: number, staleDays: number, kind = 'all', now = Date.now()): AuditResult {
  const result: AuditResult = { duplicates: [], stale: [], orphans: [], long: [], conflicts: [], coverage: { approximateChunkLimit: 2000, staleChunkLimit: 10000, perCategoryLimit: 50 } }
  if (kind === 'all' || kind === 'duplicates') {
    result.duplicates = db.all('SELECT text_hash,COUNT(*) count,GROUP_CONCAT(id) chunk_ids FROM chunks GROUP BY text_hash HAVING COUNT(*)>1 LIMIT 50')
    const candidates = db.all('SELECT id,doc_id,text FROM chunks ORDER BY id LIMIT 2000')
    const fingerprints = new Map<string, Row>()
    for (const row of candidates) {
      const fingerprint = row.text.replace(/[\p{P}\s]/gu, '')
      const prior = fingerprints.get(fingerprint)
      if (fingerprint.length >= 30 && prior && prior.text !== row.text && result.duplicates.length < 50) result.duplicates.push({ chunk_ids: prior.id + ',' + row.id, count: 2, approximate: true })
      else fingerprints.set(fingerprint, row)
    }
  }
  if (kind === 'all' || kind === 'stale') {
    const cutoff = now - staleDays * 86400000
    for (const row of db.all('SELECT c.id,c.text,d.title,d.source FROM chunks c JOIN documents d ON d.id=c.doc_id ORDER BY c.id LIMIT 10000')) {
      const dates = (row.title + '\n' + row.text).match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []
      const old = dates.filter((date: string) => Number.isFinite(Date.parse(date)) && Date.parse(date) < cutoff)
      if (old.length && result.stale.length < 50) result.stale.push({ id: row.id, source: row.source, dates: [...new Set(old)], note: '含较早日期，不代表事实已失效' })
    }
  }
  if (kind === 'all' || kind === 'orphans') for (const doc of db.all('SELECT id,source FROM documents')) {
    const path = join(workspace, doc.source)
    if ((!existsSync(path) || lstatSync(path).isSymbolicLink()) && result.orphans.length < 50) result.orphans.push(doc)
  }
  if (kind === 'all') {
    result.long = db.all('SELECT id,start_line,doc_id,LENGTH(text) chars FROM chunks WHERE LENGTH(text)>? LIMIT 50', maxChars * 1.5)
    result.conflicts = db.all("SELECT a.chunk_id,a.conflicts_json,d.source,c.start_line,'LLM候选，未核实' note FROM annotations a JOIN chunks c ON c.id=a.chunk_id JOIN documents d ON d.id=c.doc_id WHERE a.conflicts_json<>'[]' LIMIT 50")
  }
  return result
}
export function digest(db: BrainDb, workspace: string, days: number, maxChars: number, staleDays: number, now = Date.now()): string {
  const since = now - days * 86400000
  const docs = db.all('SELECT source,title,indexed_at_ms FROM documents WHERE indexed_at_ms>=? ORDER BY indexed_at_ms DESC LIMIT 30', since)
  const entities = db.get('SELECT COUNT(*) count FROM entities WHERE last_seen_ms>=?', since)!.count
  const due = db.get('SELECT COUNT(*) count FROM reviews WHERE due_at_ms<=?', now)!.count
  const report = audit(db, workspace, maxChars, staleDays, 'all', now)
  return `最近 ${days} 天：新增/变更文档 ${db.get('SELECT COUNT(*) count FROM documents WHERE indexed_at_ms>=?', since)!.count}，涉及实体 ${entities}，到期复习 ${due}。\n${docs.map(doc => doc.source + ' — ' + doc.title).join('\n')}\n审计（展示上限 50/类）：重复 ${report.duplicates.length}、含早期日期 ${report.stale.length}、孤儿 ${report.orphans.length}、过长 ${report.long.length}。`
}
