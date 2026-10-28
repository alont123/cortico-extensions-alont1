/**
 * 按建议表体检一份配置：每条规则给出「现在的值」「建议值」「合不合规」「为什么」。
 *
 * 只读，不改。缺键按「合规且未知」处理（框架有默认值，缺键不等于关着）——
 * 但缺的键如果是「必须有」的那种（比如 antiLoop.enabled），就报出来让人自己确认。
 */
export function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), obj)
}

export function setPath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (const key of keys.slice(0, -1)) {
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
  cur[keys[keys.length - 1]] = value
}

function verdict(rule, current) {
  if (current === undefined) return 'absent'
  switch (rule.kind) {
    case 'atLeast': return typeof current === 'number' && current >= rule.value ? 'ok' : 'off'
    case 'atMost': return typeof current === 'number' && current <= rule.value ? 'ok' : 'off'
    case 'isTrue': return current === true ? 'ok' : 'off'
    case 'isFalse': return current === false ? 'ok' : 'off'
    case 'oneOf': return Array.isArray(rule.value) && rule.value.includes(current) ? 'ok' : 'off'
    default: return 'ok'
  }
}

export function checkRules(config, rules = []) {
  const out = []
  for (const rule of rules) {
    if (rule.onlyWhen) {
      const gate = getPath(config, rule.onlyWhen.path)
      const gateOk = rule.onlyWhen.kind === 'isTrue' ? gate === true : gate !== undefined
      if (!gateOk) continue
    }
    const current = getPath(config, rule.path)
    out.push({ rule, current, verdict: verdict(rule, current) })
  }
  return out
}

/** 自动改的时候用什么值：优先 suggest，其次规则里那个阈值。 */
export function targetValue(rule) {
  if (rule.suggest !== undefined) return rule.suggest
  if (rule.kind === 'isTrue') return true
  if (rule.kind === 'isFalse') return false
  return rule.value
}
