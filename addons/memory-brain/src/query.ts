// Query-side keyword recall only. The stored tokenizer and index stay intact.
// Plain keyword, quoted, wildcard and code queries retain literal semantics.
const filler = new Set(('我 你 他 她 它 我们 你们 他们 她们 这 那 这个 那个 的 了 过 着 吗 呢 吧 啊 是 在 有 和 与 或 都 很 也 就 还 又 曾 曾经 之前 以前 记得 说 说过 提到 问 请 帮 帮我 一下 什么 怎么 怎样 如何 为什么 为何 时候 什么时候 哪里 哪儿 哪个 哪些 哪 种 是否 能否 可以 能 不能 知道 告诉 关于 中 里 咱们').split(' '))
let segmenter: Intl.Segmenter | undefined

export function questionTerms(query: string): string[] {
  if (!/\p{Script=Han}/u.test(query) || !/[?？]|什么|怎么|怎样|如何|为什么|为何|什么时候|哪里|哪儿|哪个|哪些|哪种|是否|能否|吗/u.test(query) || /[\\%_`"'*“”‘’「」『』]/.test(query)) return []
  segmenter ??= new Intl.Segmenter('zh', { granularity: 'word' })
  return [...new Set([...segmenter.segment(query)].filter(part => part.isWordLike).map(part => part.segment.toLowerCase()).filter(word => !filler.has(word) && (Array.from(word).length > 1 || /\p{Script=Han}/u.test(word))))].slice(0, 8)
}
