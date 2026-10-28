import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Enumerate only ordinary files inside an explicitly selected source root. */
export function sourceFiles(root: string, maxFiles = 3000, maxBytes = 4 * 1024 * 1024): string[] {
  if (!root) return []
  let canonical: string
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return []
    canonical = realpathSync(root)
  } catch { return [] }
  const files: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 24 || files.length >= maxFiles) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'blobs' || entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      try {
        const inside = relative(canonical, realpathSync(full))
        if (!inside || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) continue
        if (entry.isDirectory()) walk(full, depth + 1)
        else if (entry.isFile() && /\.(?:md|txt|json|jsonl|csv|log)$/i.test(entry.name) && statSync(full).size <= maxBytes) files.push(relative(root, full).replaceAll('\\', '/'))
      } catch { /* An unavailable source does not stop other files. */ }
    }
  }
  walk(resolve(root), 0)
  return files
}
