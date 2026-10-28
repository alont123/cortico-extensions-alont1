import type { BrainConfig } from './config.ts'
import type { BrainDb } from './db.ts'
import { statSync } from 'node:fs'

// Reserve archive paths even when disabled, so an old explicit include cannot
// silently put handoffs back in the core database. Exclude the directory itself
// as well, avoiding traversal of the default handoffs tree.
export function coreConfig(cfg: BrainConfig): BrainConfig {
  return { ...cfg, exclude: [...cfg.exclude, 'handoffs', 'handoffs/**', ...cfg.archive.include] }
}
export function archiveConfig(cfg: BrainConfig): BrainConfig {
  return { ...cfg, include: cfg.archive.include, llm: { ...cfg.llm, enabled: false } }
}
export function databaseStats(db?: BrainDb) {
  if (!db) return { documents: 0, chunks: 0, entities: 0, due: 0, lastSync: null, dbBytes: 0, tokenizer: null, schemaVersion: null, coverage: [] }
  let bytes = 0
  for (const suffix of ['', '-wal', '-shm']) { try { bytes += statSync(db.file + suffix).size } catch {} }
  return {
    documents: db.get('SELECT COUNT(*) n FROM documents')!.n,
    chunks: db.get('SELECT COUNT(*) n FROM chunks')!.n,
    entities: db.get('SELECT COUNT(*) n FROM entities')!.n,
    due: db.get('SELECT COUNT(*) n FROM reviews WHERE due_at_ms<=?', Date.now())!.n,
    lastSync: Number(db.meta('last_sync_ms') ?? 0) || null, dbBytes: bytes,
    tokenizer: db.tokenizer, schemaVersion: db.meta('schema_version'),
    coverage: db.all('SELECT kind,COUNT(*) documents,SUM(chunk_count) chunks FROM documents GROUP BY kind'),
  }
}
