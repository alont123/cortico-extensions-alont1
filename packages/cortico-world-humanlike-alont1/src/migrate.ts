/**
 * 旧版人味数据迁移。
 *
 * 合并版早期（以及七个独立扩展）把状态文件直接放在 <dataDir>/ 下；
 * 现在的合并版收进 <dataDir>/humanlike/，否则会和别的 World 抢同一个文件。
 * 仅操作者显式开启 migrateLegacyData 后调用；新目录缺文件时复制（不移动、不覆盖）。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 各模块落盘的文件名。 */
export const MODULE_FILES = [
  'affinity.json',
  'learn.json',
  'life.json',
  'together.json',
  'mind.json',
  'real.json',
] as const

export interface MigrationEntry {
  file: string
  from: string
}

export interface MigrationResult {
  /** 实际复制过来的文件 */
  migrated: MigrationEntry[]
  /** 新目录里已有、所以没动的文件 */
  kept: string[]
  targetDir: string
}

/**
 * 把旧版数据迁到 <dataDir>/humanlike/。
 *
 * 只在新目录缺这个文件、旧目录有时才复制；两边都有时以新目录为准（kept），
 * 避免升级后第一次启动把用户新写的数据盖回旧快照。
 */
export function migrateLegacyData(dataDir: string): MigrationResult {
  const targetDir = join(dataDir, 'humanlike')
  const legacyDirs = [dataDir, join(dataDir, 'humanlike-lite'), join(dataDir, 'humanlike-legacy')]
  const migrated: MigrationEntry[] = []
  const kept: string[] = []
  let madeDir = false
  for (const file of MODULE_FILES) {
    const target = join(targetDir, file)
    if (existsSync(target)) {
      kept.push(file)
      continue
    }
    const source = legacyDirs
      .map((d) => join(d, file))
      .find((p) => p !== target && existsSync(p))
    if (!source) continue
    try {
      if (!madeDir) {
        mkdirSync(targetDir, { recursive: true })
        madeDir = true
      }
      copyFileSync(source, target)
      migrated.push({ file, from: source })
    } catch {
      /* 单个文件迁移失败不影响其余；下次启动还会再试 */
    }
  }
  return { migrated, kept, targetDir }
}
