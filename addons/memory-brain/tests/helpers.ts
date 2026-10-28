import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'
import { BrainDb } from '../src/db.ts'
import { normalizeConfig, type BrainConfig } from '../src/config.ts'
import { Enhancer } from '../src/entities.ts'
import { Ingester } from '../src/ingest.ts'

export function fixture(t: TestContext, overrides: Partial<BrainConfig> = {}, unicode = false) {
  const root = mkdtempSync(join(tmpdir(), 'brain-fixture-'))
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const cfg = normalizeConfig(overrides)
  const db = new BrainDb(join(root, 'data/brain/brain.db'), unicode)
  const enhancer = new Enhancer(db, cfg, () => '')
  const ingest = new Ingester(db, workspace, cfg, enhancer)
  t.after(async () => { ingest.stop(); await ingest.idle().catch(() => {}); db.close(); rmSync(root, { recursive: true, force: true }) })
  const write = (source: string, text: string) => { mkdirSync(dirname(join(workspace, source)), { recursive: true }); writeFileSync(join(workspace, source), text) }
  return { root, workspace, cfg, db, ingest, write }
}
