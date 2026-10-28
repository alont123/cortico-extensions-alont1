/** Windows ProcessName 不带 .exe；配置和工具输入允许引号、空白和后缀。 */
export function normalizeProcess(input: string | null | undefined): string {
  let name = String(input ?? '').trim()
  while (name.length >= 2 && ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'")))) {
    name = name.slice(1, -1).trim()
  }
  return name.replace(/\.exe$/i, '').trim().toLowerCase()
}

export function matchesAnyProcess(processes: readonly string[], actual: string): boolean {
  const name = normalizeProcess(actual)
  return name.length > 0 && processes.some(candidate => normalizeProcess(candidate) === name)
}
