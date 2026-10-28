import type { BrainDb, Row } from './db.ts'
import { questionTerms } from './query.ts'

export type SearchKind = 'memory' | 'recent' | 'notes' | 'memories' | 'handoffs'
export interface SearchOptions { query: string; mode?: string; limit?: number; since_days?: number; source?: string; kind?: SearchKind; excludeKinds?: SearchKind[]; weight?: number; now?: number }
export function search(db: BrainDb, options: SearchOptions): Row[] {
  const query = options.query.trim().slice(0, 256)
  if (!query) return []
  const now = options.now ?? Date.now()
  const tokens = query.split(/\s+/).filter(Boolean).slice(0, 8)
  const escape = (text: string) => text.replace(/[\\%_]/g, '\\$&')
  const matched = db.all("SELECT id,name FROM entities WHERE name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\' LIMIT 32", '%' + escape(query) + '%', '%' + escape(query) + '%')
  const candidates = new Map<number, Row>()
  const contains = (row: Row, token: string) => (row.text + '\n' + row.title).toLowerCase().includes(token.toLowerCase())
  const eligible = (row: Row) => row.entityHit || tokens.every(token => contains(row, token))
  const sources = () => new Set([...candidates.values()].filter(eligible).map(row => row.source)).size
  // Read old schema-1 kind values without rewriting or renumbering chunks.
  const kind = "CASE WHEN d.kind='handoff' THEN 'handoffs' WHEN d.kind='note' THEN CASE WHEN lower(d.source) LIKE 'memories/%' THEN 'memories' ELSE 'notes' END ELSE d.kind END"
  const fields = `c.*,d.source,d.title,d.mtime_ms,${kind} kind`
  const where = ' AND d.mtime_ms>=? AND (?=\'\' OR d.source LIKE ? ESCAPE \'\\\')'
  const excluded = options.excludeKinds ?? []
  const filtered = where + ` AND (?='' OR ${kind}=?)` + (excluded.length ? ` AND ${kind} NOT IN (${excluded.map(() => '?').join(',')})` : '')
  const scope = [options.since_days ? now - options.since_days * 86400000 : 0, options.source ?? '', '%' + escape(options.source ?? '') + '%', options.kind ?? '', options.kind ?? '', ...excluded]
  if (options.mode !== 'entity') {
    try {
      const expression = tokens.map(token => '"' + token.replaceAll('"', '""') + '"').join(' OR ')
      for (const row of db.all(`SELECT ${fields},chunks_fts.rank FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN documents d ON d.id=c.doc_id WHERE chunks_fts MATCH ?${filtered} ORDER BY chunks_fts.rank LIMIT 100`, expression, ...scope)) candidates.set(row.id, { ...row, score: 1 + Math.min(2, Math.abs(row.rank)) })
    } catch (error) {
      // Trigram does not match short Chinese terms; LIKE also handles literal punctuation.
      if (!(error instanceof Error)) throw error
    }
    const clauses = tokens.map(() => "(c.text LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')").join(' AND ')
    const args = tokens.flatMap(token => ['%' + escape(token) + '%', '%' + escape(token) + '%'])
    if (sources() < (options.limit ?? 8) || tokens.some(token => Array.from(token).length < 3)) {
      for (const row of db.all(`SELECT ${fields} FROM documents d JOIN chunks c ON c.doc_id=d.id WHERE (${clauses})${filtered} ORDER BY d.mtime_ms DESC LIMIT 100`, ...args, ...scope)) if (!candidates.has(row.id)) candidates.set(row.id, { ...row, score: 0.8 })
    }
  }
  if (options.mode !== 'keyword' && matched.length) {
    const marks = matched.map(() => '?').join(',')
    for (const row of db.all(`SELECT DISTINCT ${fields} FROM entity_mentions m JOIN chunks c ON c.id=m.chunk_id JOIN documents d ON d.id=c.doc_id WHERE m.entity_id IN (${marks})${filtered} LIMIT 100`, ...matched.map(item => item.id), ...scope)) {
      const prior = candidates.get(row.id)
      candidates.set(row.id, { ...row, score: (prior?.score ?? 0.4) + 0.5, entityHit: true })
    }
  }
  // First preserve every usable literal/entity hit. Only question-like Chinese
  // queries with too few distinct sources may add relaxed keyword candidates.
  // All SQL paths reuse the same date/source/kind/exclusion bindings above.
  for (const [id, row] of candidates) if (!eligible(row)) candidates.delete(id)
  const fallback = options.mode !== 'entity' && sources() < (options.limit ?? 8) ? questionTerms(query) : []
  if (fallback.length) {
    const add = (row: Row) => {
      if (candidates.has(row.id)) return
      const matchedTerms = fallback.filter(term => contains(row, term))
      if (matchedTerms.length) candidates.set(row.id, { ...row, score: 0.5, match: 'keywords', matchedTerms })
    }
    try {
      const expression = fallback.map(term => '"' + term.replaceAll('"', '""') + '"').join(' OR ')
      for (const row of db.all(`SELECT ${fields} FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN documents d ON d.id=c.doc_id WHERE chunks_fts MATCH ?${filtered} ORDER BY chunks_fts.rank LIMIT 100`, expression, ...scope)) add(row)
    } catch (error) { if (!(error instanceof Error)) throw error }
    const count = new Set([...candidates.values()].map(row => row.source)).size
    if (count < (options.limit ?? 8) || fallback.some(term => Array.from(term).length < 3)) {
      const clauses = fallback.map(() => "(c.text LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')").join(' OR ')
      const args = fallback.flatMap(term => ['%' + escape(term) + '%', '%' + escape(term) + '%'])
      for (const row of db.all(`SELECT ${fields} FROM documents d JOIN chunks c ON c.doc_id=d.id WHERE (${clauses})${filtered} ORDER BY d.mtime_ms DESC LIMIT 100`, ...args, ...scope)) add(row)
    }
  }
  const seen = new Set<string>()
  return [...candidates.values()].map((row): Row => {
    const terms = row.match === 'keywords' ? fallback : tokens
    const matchedTerms = terms.filter(token => contains(row, token))
    const direct = matchedTerms.length
    const recent = Math.max(0, 1 - Math.max(0, now - row.mtime_ms) / (90 * 86400000)) * 0.15
    let at = terms.reduce((best, token) => { const index = row.text.toLowerCase().indexOf(token.toLowerCase()); return index < 0 ? best : Math.min(best, index) }, row.text.length)
    at = Math.max(0, at - 40)
    const snippet = Array.from(row.text.slice(at)).slice(0, 200).join('')
    return { ...row, match: row.match ?? (row.entityHit ? 'entity' : 'literal'), matchedTerms, score: (row.score + direct * 0.3 + recent) * (options.weight ?? 1), snippet }
  }).sort((a, b) => Number(a.match === 'keywords') - Number(b.match === 'keywords') || b.score - a.score || a.id - b.id).filter(row => { if (seen.has(row.source)) return false; seen.add(row.source); return true }).slice(0, options.limit ?? 8)
}
export function getChunks(db: BrainDb, id: number, context = 1): Row[] {
  const chunk = db.get('SELECT doc_id,seq FROM chunks WHERE id=?', id)
  return chunk ? db.all('SELECT c.*,d.source,d.title,a.summary,a.conflicts_json FROM chunks c JOIN documents d ON d.id=c.doc_id LEFT JOIN annotations a ON a.chunk_id=c.id WHERE c.doc_id=? AND c.seq BETWEEN ? AND ? ORDER BY c.seq', chunk.doc_id, chunk.seq - context, chunk.seq + context) : []
}
