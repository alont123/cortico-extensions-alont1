import { isBuiltin } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const allowed = {
  'cortico-world-qq-better-alont1': ['ws'],
  'cortico-world-cua-alont1': ['jpeg-js'],
  'cortico-world-bilibili-video-alont1': ['puppeteer-core', 'qrcode'],
}
function codeFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? ['node_modules', '.git', 'scratch'].includes(entry.name) ? [] : codeFiles(join(dir, entry.name))
    : entry.isFile() && /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [join(dir, entry.name)] : [])
}
export function dependencyProblems(dir, manifest) {
  const errors = []
  const packageRoot = realpathSync(dir)
  const inside = target => { const path = relative(packageRoot, target); return path !== '..' && !path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(path) }
  const declared = [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])]
  const permitted = allowed[manifest.name] ?? []
  for (const name of declared) if (!permitted.includes(name)) errors.push(`Unexpected runtime dependency: ${name}`)
  if (Object.keys(manifest.peerDependencies ?? {}).length) errors.push('Unexpected peer dependencies')
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (/(?:^|\/)cortico-(?:world|provider|bot)-/.test(name)) errors.push(`Cross-extension dependency in ${field}: ${name}`)
      const specifier = String(version).trim()
      if (/^(?:file:|link:|workspace:)/.test(specifier)) errors.push(`Local workspace dependency in ${field}: ${name}`)
      if (specifier.startsWith('npm:')) {
        const target = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@.*)?$/.exec(specifier)?.[1]
        if (!target) errors.push(`Unresolved npm alias in ${field}: ${name}`)
        else {
          if (/(?:^|\/)cortico-(?:world|provider|bot)-/.test(target)) errors.push(`Cross-extension alias in ${field}: ${name} -> ${target}`)
          if (field !== 'peerDependencies' && !permitted.includes(target)) errors.push(`Unexpected runtime alias target: ${name} -> ${target}`)
        }
      }
    }
  }
  const imports = []
  for (const file of codeFiles(dir)) {
    const tree = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause, named = clause?.namedBindings
        const typeOnly = clause?.isTypeOnly === true || !clause?.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(item => item.isTypeOnly)
        imports.push({ file, specifier: node.moduleSpecifier.text, typeOnly: Boolean(typeOnly) })
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const named = node.exportClause
        const typeOnly = node.isTypeOnly || named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every(item => item.isTypeOnly)
        imports.push({ file, specifier: node.moduleSpecifier.text, typeOnly: Boolean(typeOnly) })
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression
        if (expression && ts.isStringLiteralLike(expression)) imports.push({ file, specifier: expression.text, typeOnly: node.isTypeOnly })
        else errors.push(`Unresolved external import: ${relative(dir, file)}`)
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.push({ file, specifier: node.arguments[0].text, typeOnly: false })
        else errors.push(`Dynamic import needs explicit isolation review: ${relative(dir, file)}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`)
      }
      if (ts.isImportTypeNode(node)) {
        if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) imports.push({ file, specifier: node.argument.literal.text, typeOnly: true })
        else errors.push(`Unresolved type import: ${relative(dir, file)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  for (const { file, specifier, typeOnly } of imports) {
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier)
      if (!inside(target) || existsSync(target) && !inside(realpathSync(target))) errors.push(`Relative import leaves package: ${relative(dir, file)} -> ${specifier}`)
      else if (!existsSync(target)) errors.push(`Missing packaged relative import: ${relative(dir, file)} -> ${specifier}`)
      continue
    }
    if (isAbsolute(specifier) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) && !specifier.startsWith('node:')) {
      errors.push(`Non-portable import: ${relative(dir, file)} -> ${specifier}`); continue
    }
    if (isBuiltin(specifier) || specifier === 'cortico' || specifier.startsWith('cortico/')) continue
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    if (/(?:^|\/)cortico-(?:world|provider|bot)-/.test(name)) errors.push(`Cross-extension import: ${name}`)
    if (!typeOnly && !declared.includes(name)) errors.push(`Undeclared runtime import: ${name}`)
  }
  return [...new Set(errors)]
}
