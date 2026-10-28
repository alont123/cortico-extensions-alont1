/** Independent JS runner. Guest objects are never inspected by the parent process. */
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'

let input = ''
for await (const part of process.stdin) {
  input += part
  if (input.length > 1024 * 1024) process.exit(1)
}
try {
  const { code, name, timeoutMs } = JSON.parse(input)
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  })
  const options = { timeout: Math.min(30000, Math.max(100, Number(timeoutMs) || 1000)) }
  new vm.Script(`
    const output = [];
    let outputChars = 0;
    const encode = value => typeof value === 'bigint' ? String(value) + 'n' :
      (typeof value === 'string' ? value : JSON.stringify(value));
    const append = values => {
      if (outputChars >= 16000) return;
      const line = values.map(encode).join(' ').slice(0, 16000 - outputChars);
      output.push(line); outputChars += line.length;
    };
    globalThis.console = Object.freeze({
      log: (...values) => append(values),
      error: (...values) => append(['[err]', ...values]),
    });
    const stringifyResult = value => value === undefined ? '' : '\\n返回值：' + encode(value);
  `).runInContext(context, options)
  const value = new vm.Script(String(code), { filename: String(name) }).runInContext(context, options)
  const key = '__result_' + randomUUID().replaceAll('-', '')
  Object.defineProperty(context, key, { value, configurable: true })
  const result = new vm.Script(`((output.length ? output.join('\\n') : '(没有输出)') + stringifyResult(globalThis[${JSON.stringify(key)}])).slice(0, 16000)`).runInContext(context, options)
  process.stdout.write(JSON.stringify({ ok: typeof result === 'string', text: typeof result === 'string' ? result : '' }))
} catch {
  process.stdout.write(JSON.stringify({ ok: false, text: '' }))
}
process.exit(0)
