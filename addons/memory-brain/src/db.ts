import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export type Row = Record<string, any>
export class BrainDb {
  readonly sql: DatabaseSync
  readonly tokenizer: string
  recovered = false
  constructor(readonly file: string, forceUnicode = false) {
    for (const path of [dirname(file), file, file + '-wal', file + '-shm']) {
      try { if (lstatSync(path).isSymbolicLink()) throw new Error('数据库目录或文件不能是链接') }
      catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    }
    mkdirSync(dirname(file), { recursive: true })
    let database: DatabaseSync
    try {
      database = new DatabaseSync(file)
      try {
        const check = database.prepare('PRAGMA integrity_check').get() as Row
        if (Object.values(check)[0] !== 'ok') throw new Error('corrupt')
      } catch (error) { database.close(); throw error }
    } catch (error) {
      const fault = error as { code?: string; errcode?: number; message?: string }
      if (fault.message !== 'corrupt' && ![11, 26].includes(fault.errcode ?? -1)) throw new Error('数据库无法打开，请检查数据目录权限')
      const suffix = '.corrupt-' + Date.now()
      for (const part of ['', '-wal', '-shm']) if (existsSync(file + part)) renameSync(file + part, file + suffix + part)
      this.recovered = true
      database = new DatabaseSync(file)
    }
    this.sql = database
    try {
      this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
      const existing = this.meta('schema_version')
      if (existing && existing !== '1') throw new Error('数据库版本较新，请升级扩展；原库未重建')
      this.transaction(() => this.sql.exec(`
        CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY,source TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,title TEXT NOT NULL,mtime_ms REAL NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,indexed_at_ms INTEGER NOT NULL,chunk_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,seq INTEGER NOT NULL,text TEXT NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,token_count INTEGER NOT NULL,text_hash TEXT NOT NULL,UNIQUE(doc_id,seq));
        CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id,seq);
        CREATE INDEX IF NOT EXISTS documents_time ON documents(mtime_ms DESC);
        CREATE TABLE IF NOT EXISTS annotations(chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,summary TEXT NOT NULL,conflicts_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entities(id INTEGER PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,aliases_json TEXT NOT NULL DEFAULT '[]',mention_count INTEGER NOT NULL DEFAULT 0,first_seen_ms INTEGER,last_seen_ms INTEGER,UNIQUE(type,name));
        CREATE TABLE IF NOT EXISTS entity_mentions(entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,count INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(entity_id,chunk_id));
        CREATE INDEX IF NOT EXISTS entity_mentions_chunk ON entity_mentions(chunk_id);
        CREATE TABLE IF NOT EXISTS relations(id INTEGER PRIMARY KEY,from_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,to_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,relation TEXT NOT NULL,source_doc INTEGER REFERENCES documents(id) ON DELETE CASCADE,confidence REAL NOT NULL DEFAULT 0.5,UNIQUE(from_entity,to_entity,source_doc));
        CREATE INDEX IF NOT EXISTS relations_source ON relations(source_doc);
        CREATE INDEX IF NOT EXISTS relations_to ON relations(to_entity);
        CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,title TEXT NOT NULL,text TEXT NOT NULL,text_hash TEXT NOT NULL UNIQUE,due_at_ms INTEGER NOT NULL,interval_days INTEGER NOT NULL DEFAULT 1,ease REAL NOT NULL DEFAULT 2.3,reps INTEGER NOT NULL DEFAULT 0,lapses INTEGER NOT NULL DEFAULT 0,last_grade INTEGER,source TEXT,tags_json TEXT NOT NULL DEFAULT '[]',created_at_ms INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS reviews_chunk ON reviews(chunk_id);
        CREATE INDEX IF NOT EXISTS reviews_due ON reviews(due_at_ms);
        CREATE TABLE IF NOT EXISTS sync_log(id INTEGER PRIMARY KEY,started_at_ms INTEGER,finished_at_ms INTEGER,files_seen INTEGER,files_changed INTEGER,chunks_written INTEGER,error TEXT);
        CREATE TABLE IF NOT EXISTS llm_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      `))
      if (!this.meta('tokenizer')) {
        try { if (forceUnicode) throw new Error('fixture'); this.sql.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text,title,source,tokenize='trigram')"); this.setMeta('tokenizer', 'trigram') }
        catch { this.sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text,title,source,tokenize='unicode61')"); this.setMeta('tokenizer', 'unicode61') }
      }
      this.tokenizer = this.meta('tokenizer')!
      this.setMeta('schema_version', '1')
    } catch (error) { this.sql.close(); throw error }
  }
  transaction<T>(action: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.sql.exec('COMMIT'); return result }
    catch (error) { this.sql.exec('ROLLBACK'); throw error }
  }
  meta(key: string): string | undefined { return (this.sql.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined)?.value }
  setMeta(key: string, value: string): void { this.sql.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  all(query: string, ...args: any[]): Row[] { return this.sql.prepare(query).all(...args) as Row[] }
  get(query: string, ...args: any[]): Row | undefined { return this.sql.prepare(query).get(...args) as Row | undefined }
  removeDocument(id: number): void {
    this.sql.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?)').run(id)
    this.sql.prepare('DELETE FROM documents WHERE id=?').run(id)
  }
  refreshEntities(): void {
    this.sql.exec(`DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM entity_mentions);
      UPDATE entities SET mention_count=(SELECT COALESCE(SUM(count),0) FROM entity_mentions WHERE entity_id=entities.id),
      first_seen_ms=(SELECT MIN(d.indexed_at_ms) FROM entity_mentions m JOIN chunks c ON c.id=m.chunk_id JOIN documents d ON d.id=c.doc_id WHERE m.entity_id=entities.id),
      last_seen_ms=(SELECT MAX(d.indexed_at_ms) FROM entity_mentions m JOIN chunks c ON c.id=m.chunk_id JOIN documents d ON d.id=c.doc_id WHERE m.entity_id=entities.id);`)
  }
  compactIfPending(): void {
    if (this.meta('compact_pending') !== '1') return
    this.sql.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize'); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)")
    this.setMeta('compact_pending', '0')
    this.sql.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }
  close(): void { this.sql.close() }
}
