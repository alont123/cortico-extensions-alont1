/**
 * 框架 `core/util.ts` 里没有、只有本扩展需要的两个纯函数。
 *
 * 为什么不直接从框架拿：这两个是这台机器的框架**本地新增**的（上游没有），
 * 而本扩展是要发出去给别人装的。写在扩展里，它在打了补丁的框架和干净的
 * `cortico@0.1.13` 上都能加载；从框架导入则在干净框架上直接
 * `does not provide an export named 'clampText'` 而加载失败。
 */

/** 落单的代理项（半个 emoji）。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 把落单的代理项换成 U+FFFD。
 *
 * 按字数截断会把 emoji 劈成两半，剩下的半个代理项经 `JSON.stringify` 写成
 * `"\ud83d"`，服务端解析报 `unexpected end of hex escape` 并整条请求 400。
 */
export function stripLoneSurrogates(text: string): string {
  return LONE_SURROGATE.test(text) ? text.replace(LONE_SURROGATE, '\uFFFD') : text;
}

/** 按字符数截断，但不劈开代理对：emoji 要么整个留下，要么整个去掉。 */
export function clampText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const end = text.charCodeAt(maxChars - 1) >= 0xd800 && text.charCodeAt(maxChars - 1) <= 0xdbff ? maxChars - 1 : maxChars;
  return text.slice(0, end);
}
