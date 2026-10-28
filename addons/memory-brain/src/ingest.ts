import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { setImmediate as yieldNow } from 'node:timers/promises'
import { safeRelative, type BrainConfig } from './config.ts'
import { type BrainDb, type Row } from './db.ts'
import { Enhancer, storeEntities } from './entities.ts'

export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function sourceKind(source: string): string {
  return /^MEMORY\.md$/i.test(source) ? 'memory' : /^RECENT\.md$/i.test(source) ? 'recent' : /^handoffs\//i.test(source) ? 'handoffs' : /^memories\//i.test(source) ? 'memories' : 'notes'
}
export interface Chunk { text: string; start: number; end: number }
export function splitChunks(content: string, max: number, min = 40): Chunk[] {
  if (!Number.isInteger(max) || max < 2) throw new Error('块长度必须至少为 2')
  const result: Chunk[] = []
  let current: Chunk | undefined
  const flush = () => { if (current?.text.trim()) result.push(current); current = undefined }
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^#{1,6}\s/.test(line)) flush()
    if (!line.trim()) {
      if (current && current.text.length >= min) flush()
      else if (current && index < lines.length - 1) { current.text += '\n'; current.end = index + 1 }
      continue
    }
    if (current && current.text.length + line.length + 1 > max) flush()
    for (let start = 0; start < line.length;) {
      let end = Math.min(start + max, line.length)
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1])) end--
      const part = line.slice(start, end)
      if (current && current.text.length + part.length + 1 > max) flush()
      if (!current) current = { text: part, start: index + 1, end: index + 1 }
      else { current.text += '\n' + part; current.end = index + 1 }
      start = end
      if (start < line.length) flush()
    }
  }
  flush()
  return result
}
export function globRegex(pattern: string): RegExp {
  const value = safeRelative(pattern, true)
  let output = '^'
  for (let index = 0; index < value.length; index++) {
    if (value.slice(index, index + 3) === '**/') { output += '(?:.*/)?'; index += 2 }
    else if (value.slice(index, index + 2) === '**') { output += '.*'; index++ }
    else if (value[index] === '*') output += '[^/]*'
    else if (value[index] === '?') output += '[^/]'
    else output += value[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(output + '$', 'i')
}
export interface SyncResult { added: number; updated: number; deleted: number; skipped: number; errors: number; seen: number; chunks: number; deferred: number; elapsedMs: number }
export class Ingester {
  private active: Promise<SyncResult> | undefined
  private closed = false
  constructor(private db: BrainDb, readonly workspace: string, private cfg: BrainConfig, private enhancer: Enhancer) {}
  stop(): void { this.closed = true }
  sync(options: { full?: boolean; paths?: string[]; signal?: AbortSignal } = {}): Promise<SyncResult> {
    if (this.closed) return Promise.reject(new Error('索引器已停止'))
    if (this.active) return this.active.then(() => this.sync(options))
    this.active = this.run(options).finally(() => { this.active = undefined })
    return this.active
  }
  async idle(): Promise<void> { await this.active }
  private async run(options: { full?: boolean; paths?: string[]; signal?: AbortSignal }): Promise<SyncResult> {
    const begin = Date.now()
    const result: SyncResult = { added: 0, updated: 0, deleted: 0, skipped: 0, errors: 0, seen: 0, chunks: 0, deferred: 0, elapsedMs: 0 }
    const include = this.cfg.include.map(globRegex); const exclude = this.cfg.exclude.map(globRegex)
    const selected = (source: string) => include.some(pattern => pattern.test(source)) && !source.split('/').some((_, index, parts) => exclude.some(pattern => pattern.test(parts.slice(0, index + 1).join('/')))) && (!/\.jsonl$/i.test(source) || this.cfg.includeConversations)
    const paths = options.paths?.map(path => safeRelative(path))
    const inScope = (source: string) => !paths?.length || paths.some(path => source === path || source.startsWith(path + '/'))
    const rootInfo = await lstat(this.workspace)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('工作区目录不可用或是链接')
    const root = await realpath(this.workspace)
    const sources: string[] = []
    const walk = async (dir: string) => {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (this.closed || options.signal?.aborted) throw new Error('同步已取消')
        const abs = join(dir, entry.name); const source = relative(this.workspace, abs).replaceAll('\\', '/')
        if (entry.isSymbolicLink() || exclude.some(pattern => pattern.test(source)) || ['.git', 'node_modules', 'blobs'].includes(entry.name)) continue
        if (entry.isDirectory()) await walk(abs)
        else if (entry.isFile() && /\.(md|txt|jsonl)$/i.test(source) && (!/\.jsonl$/i.test(source) || this.cfg.includeConversations) && include.some(pattern => pattern.test(source)) && inScope(source)) sources.push(source)
      }
      await yieldNow()
    }
    await walk(this.workspace)
    // 首轮大工作区必须先把「一直成立的东西」排到前面；否则 200 个 handoffs 会吃满配额。
    const rank = (source: string): number => source === 'MEMORY.md' ? 0 : source === 'RECENT.md' ? 1 : source.startsWith('memories/') ? 2 : source.startsWith('notes/') ? 3 : source.startsWith('handoffs/') ? 4 : 5
    sources.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    result.seen = sources.length
    const existing = new Map(this.db.all('SELECT * FROM documents').map(row => [row.source, row]))
    let processed = 0
    try {
      for (const source of sources) {
        if (this.closed || options.signal?.aborted) throw new Error('同步已取消')
        const before = existing.get(source)
        const abs = join(this.workspace, source)
        try {
          const [stat, resolved] = await Promise.all([lstat(abs), realpath(abs)])
          const physical = relative(root, resolved)
          if (stat.isSymbolicLink() || physical.startsWith('..') || isAbsolute(physical)) { result.errors++; continue }
          if (stat.size > this.cfg.maxFileBytes) { result.skipped++; continue }
          if (!options.full && before?.mtime_ms === stat.mtimeMs && before.size_bytes === stat.size) { result.skipped++; continue }
          if (processed >= this.cfg.maxFilesPerSync) { result.deferred++; continue }
          processed++
          const content = await readFile(abs, 'utf8')
          const after = await lstat(abs)
          if (after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) { result.deferred++; continue }
          const digest = hash(content)
          if (before?.sha256 === digest) { this.db.sql.prepare('UPDATE documents SET mtime_ms=?,size_bytes=? WHERE id=?').run(stat.mtimeMs, stat.size, before.id); result.skipped++; continue }
          const chunks = splitChunks(content, this.cfg.maxChunkChars, this.cfg.minChunkChars)
          const enriched = await this.enhancer.enrich(chunks.map(chunk => chunk.text), options.signal)
          if (this.closed || options.signal?.aborted) throw new Error('同步已取消')
          this.db.transaction(() => {
            if (before) this.db.removeDocument(before.id)
            const title = (content.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? source.split('/').pop()!).slice(0, 160)
            const kind = sourceKind(source)
            const id = Number(this.db.sql.prepare('INSERT INTO documents(source,kind,title,mtime_ms,size_bytes,sha256,indexed_at_ms,chunk_count) VALUES(?,?,?,?,?,?,?,?)').run(source, kind, title, stat.mtimeMs, stat.size, digest, Date.now(), chunks.length).lastInsertRowid)
            const insert = this.db.sql.prepare('INSERT INTO chunks(doc_id,seq,text,start_line,end_line,token_count,text_hash) VALUES(?,?,?,?,?,?,?)')
            const fts = this.db.sql.prepare('INSERT INTO chunks_fts(rowid,text,title,source) VALUES(?,?,?,?)')
            const chunkIds = chunks.map((chunk, seq) => {
              const chunkId = Number(insert.run(id, seq, chunk.text, chunk.start, chunk.end, Math.ceil(chunk.text.length / 2), hash(chunk.text)).lastInsertRowid)
              fts.run(chunkId, chunk.text, title, source)
              if (enriched[seq].summary || enriched[seq].conflicts.length) this.db.sql.prepare('INSERT INTO annotations VALUES(?,?,?)').run(chunkId, enriched[seq].summary, JSON.stringify(enriched[seq].conflicts))
              return { id: chunkId, enrichment: enriched[seq] }
            })
            storeEntities(this.db, id, chunkIds)
          })
          if (before) result.updated++; else result.added++
          result.chunks += chunks.length
        } catch (error) {
          if (this.closed || options.signal?.aborted) throw error
          result.errors++
        }
        if (processed % 10 === 0) await yieldNow()
      }
      const found = new Set(sources)
      this.db.transaction(() => {
        for (const [source, doc] of existing) {
          // Config exclusions apply globally, including a paths-scoped sync.
          // Ordinary deletion still respects the caller's scan scope.
          if (!selected(source) || (inScope(source) && !found.has(source))) {
            this.db.removeDocument(doc.id); result.deleted++
            if (!selected(source)) this.db.setMeta('compact_pending', '1')
          } else if (doc.kind !== sourceKind(source)) {
            this.db.sql.prepare('UPDATE documents SET kind=? WHERE id=?').run(sourceKind(source), doc.id)
          }
        }
        if (result.added || result.updated || result.deleted) this.db.refreshEntities()
        if (this.db.meta('compact_pending') === '1') this.db.sql.exec('DELETE FROM llm_cache')
        this.db.setMeta('last_sync_ms', String(Date.now()))
        this.db.sql.prepare('INSERT INTO sync_log(started_at_ms,finished_at_ms,files_seen,files_changed,chunks_written,error) VALUES(?,?,?,?,?,?)').run(begin, Date.now(), result.seen, result.added + result.updated + result.deleted, result.chunks, result.errors ? 'FILE_READ_OR_INDEX_ERROR' : null)
      })
      // DELETE alone leaves the old handoff pages on disk. Reclaim once after
      // a config migration, outside a transaction; retry on the next sync if busy.
      this.db.compactIfPending()
    } finally { result.elapsedMs = Date.now() - begin }
    return result
  }
}
