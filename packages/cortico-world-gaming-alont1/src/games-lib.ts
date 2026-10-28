import { normalizeProcess } from './proc.ts'
/**
 * 游戏库：把「配置里手填的 slots」「data 目录里 runtime 加的游戏」「老的 games 数组」合成一份。
 *
 * 配置界面的快速区给了 6 个格子（进程名|显示名|别名|看什么），
 * 工具 gaming_library 加的游戏落 `<dataDir>/gaming-lib.json`，重启后还在。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GameConfig, SimpleGamesConfig } from './config.ts'

/** 解析一行 "进程名 | 显示名 | 别名1,别名2 | 看什么"。进程名必填。 */
export function parseGameLine(line: string): GameConfig | null {
  const text = String(line ?? '').trim()
  if (!text) return null
  const parts = text.split(/[|｜]/).map((s) => s.trim())
  const proc = normalizeProcess(parts[0])
  if (!proc) return null
  const name = parts[1] || proc
  const aliases = (parts[2] ?? '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  const watchFor = parts[3] || undefined
  return { id: proc.replace(/[^a-z0-9_-]+/g, '-'), name, processes: [proc], aliases, watchFor }
}

/** 把快速配置区的 6 个格子解析成游戏条目。 */
export function parseSimpleGames(simple: SimpleGamesConfig | undefined): { games: GameConfig[]; warnings: string[] } {
  const games: GameConfig[] = []
  const warnings: string[] = []
  if (!simple) return { games, warnings }
  for (const key of ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6'] as const) {
    const raw = String(simple[key] ?? '').trim()
    if (!raw) continue
    const g = parseGameLine(raw)
    if (!g) { warnings.push(key + ' 的内容认不出：' + raw.slice(0, 40)); continue }
    games.push(g)
  }
  return { games, warnings }
}

export function libraryFile(dataDir: string): string {
  return join(dataDir, 'gaming-lib.json')
}

export function loadLibrary(dataDir: string): GameConfig[] {
  try {
    const file = libraryFile(dataDir)
    if (!existsSync(file)) return []
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((g): g is GameConfig => !!g && typeof g === 'object' && typeof (g as GameConfig).name === 'string' && Array.isArray((g as GameConfig).processes))
  } catch {
    return []
  }
}

export function saveLibrary(dataDir: string, games: GameConfig[]): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(libraryFile(dataDir), JSON.stringify(games, null, 2), 'utf8')
  } catch { /* 落盘失败下次再说 */ }
}

/** 合并三处来源，按进程名去重（先到先得：原有 games > 快速槽 > runtime 文件）。 */
export function buildGameLibrary(cfg: { games?: GameConfig[]; simple?: SimpleGamesConfig }, dataDir: string): { games: GameConfig[]; warnings: string[] } {
  const base = Array.isArray(cfg.games) ? cfg.games : []
  const simple = parseSimpleGames(cfg.simple)
  const disk = loadLibrary(dataDir)
  const out: GameConfig[] = []
  const seen = new Set<string>()
  const add = (g: GameConfig): void => {
    const procs = (g.processes ?? []).map(normalizeProcess).filter(Boolean)
    const key = procs[0] || g.id || g.name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...g, processes: procs, aliases: g.aliases ?? [] })
  }
  for (const g of base) add(g)
  for (const g of simple.games) add(g)
  for (const g of disk) add(g)
  return { games: out, warnings: simple.warnings }
}
