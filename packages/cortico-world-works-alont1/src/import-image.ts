import { createHash } from 'node:crypto';

/** 导入接口只接受有对应文件头的栅格图片；不执行解码或任何附件内容。 */
export const WORKS_MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function inspectImage(bytes: Uint8Array, mime: string): { ext: string; sha256: string } {
  if (bytes.byteLength === 0 || bytes.byteLength > WORKS_MAX_IMPORT_BYTES) {
    throw new Error('图片必须大于 0 字节且不超过 20 MiB。');
  }
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const ext = mime === 'image/png' && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : mime === 'image/jpeg' && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'jpg'
    : mime === 'image/gif' && /^(GIF87a|GIF89a)$/.test(head.subarray(0, 6).toString('ascii')) ? 'gif'
    : mime === 'image/webp' && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp'
    : null;
  if (!ext) throw new Error('仅支持 MIME 与文件头一致的 PNG、JPEG、GIF、WebP；不导入 SVG、网页或未知格式。');
  return { ext, sha256: createHash('sha256').update(bytes).digest('hex') };
}
