import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { BrainDb } from '../src/db.ts'
import { normalizeConfig } from '../src/config.ts'
import { Enhancer } from '../src/entities.ts'
import { Ingester } from '../src/ingest.ts'
import { search } from '../src/search.ts'

mkdirSync('scratch', { recursive: true }); mkdirSync('reports', { recursive: true })
const root = mkdtempSync(join(process.cwd(), 'scratch/performance-')); const workspace = join(root, 'workspace'); mkdirSync(join(workspace, 'notes'), { recursive: true })
for (let index = 0; index < 500; index++) {
  const chunks = Array.from({ length: 10 }, (_, seq) => `# 文档${index}段落${seq}\n项目：纸舟 2026-01-01 ${index === 42 && seq === 2 ? '青禾交流基地的约定' : '本地记忆测试'}。${'脱敏文本用于验证检索性能，真实工作区未被读取。'.repeat(20)}`)
  writeFileSync(join(workspace, 'notes', String(index).padStart(3, '0') + '.md'), chunks.join('\n\n'))
}
const cfg = normalizeConfig(); const db = new BrainDb(join(root, 'brain.db')); const ingest = new Ingester(db, workspace, cfg, new Enhancer(db, cfg, () => ''))
try {
  let responsive = false; setImmediate(() => { responsive = true })
  const start = performance.now(); let passes = 0; let result
  do { result = await ingest.sync(); passes++; if (result.errors) throw new Error('Benchmark indexing failed') } while (result.deferred)
  const indexMs = performance.now() - start
  const samples = []
  for (let index = 0; index < 20; index++) { const start = performance.now(); const hits = search(db, { query: index % 2 ? '本地记忆测试' : '青禾交流基地' }); samples.push(performance.now() - start); if (!hits.length) throw new Error('Benchmark search missed') }
  const report = { documents: db.get('SELECT COUNT(*) n FROM documents').n, chunks: db.get('SELECT COUNT(*) n FROM chunks').n, indexMs: Math.round(indexMs), searchMaxMs: Number(Math.max(...samples).toFixed(2)), searchMedianMs: Number([...samples].sort((a, b) => a - b)[10].toFixed(2)), syncPasses: passes, eventLoopYielded: responsive, node: process.version, sqlite: db.get('SELECT sqlite_version() version').version }
  console.log(JSON.stringify(report, null, 2)); writeFileSync('reports/performance.json', JSON.stringify(report, null, 2) + '\n')
  if (report.documents !== 500 || report.chunks !== 5000 || indexMs >= 5000 || report.searchMaxMs >= 100 || !responsive) process.exitCode = 1
} finally { ingest.stop(); await ingest.idle(); db.close(); rmSync(root, { recursive: true, force: true }) }
