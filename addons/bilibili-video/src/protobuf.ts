/**
 * Protobuf wire-format reader: field numbers, wire types and raw values, no `.proto`; the caller
 * reads the layout. Failures yield null, undefined or an empty string. A single-valued field takes
 * the last occurrence of its number, as protobuf does.
 *
 * Copied from Cortico `src/worlds/bilibili/protobuf.ts` (MIT, https://github.com/Pal-AI-Lab/Cortico,
 * commit 786b79a9), keeping the functions this package uses. Builds that leave out Cortico's
 * built-in platform Worlds, such as Coopanion, do not ship that file.
 */

/** One field as read. `varint` or `bytes` depending on the wire type. */
export interface PbField {
  readonly field: number;
  readonly wire: number;
  readonly varint?: bigint;
  readonly bytes?: Uint8Array;
}

const TEXT = new TextDecoder('utf-8', { fatal: true });

/** Reads one level of fields; truncated input, an out-of-range length or an unsupported wire type gives null. */
export function pbDecode(buf: Uint8Array): PbField[] | null {
  const out: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const key = readVarint(buf, i);
    if (!key) return null;
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (field <= 0) return null;
    if (wire === 0) {
      const value = readVarint(buf, i);
      if (!value) return null;
      i = value.next;
      out.push({ field, wire, varint: value.value });
    } else if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      const start = len.next;
      const end = start + Number(len.value);
      if (!Number.isSafeInteger(end) || end > buf.length) return null;
      out.push({ field, wire, bytes: buf.subarray(start, end) });
      i = end;
    } else if (wire === 5 || wire === 1) {
      const width = wire === 5 ? 4 : 8;
      if (i + width > buf.length) return null;
      out.push({ field, wire, bytes: buf.subarray(i, i + width) });
      i += width;
    } else {
      return null;
    }
  }
  return out;
}

/** The field's bytes as UTF-8; missing bytes, invalid UTF-8 or a control character gives an empty string. */
export function pbText(fields: readonly PbField[] | null, field: number): string {
  const bytes = pick(fields, field)?.bytes;
  if (!bytes) return '';
  let text: string;
  try {
    text = TEXT.decode(bytes);
  } catch {
    return '';
  }
  return hasControlChars(text) ? '' : text;
}

/** The field's varint; missing or beyond the safe integer range gives undefined. */
export function pbInt(fields: readonly PbField[] | null, field: number): number | undefined {
  const value = pick(fields, field)?.varint;
  if (value === undefined) return undefined;
  const num = Number(value);
  return Number.isSafeInteger(num) ? num : undefined;
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function pick(fields: readonly PbField[] | null, field: number): PbField | undefined {
  if (!fields) return undefined;
  for (let i = fields.length - 1; i >= 0; i -= 1) {
    if (fields[i].field === field) return fields[i];
  }
  return undefined;
}

/** Reads at most 10 bytes; no terminating byte gives null. */
function readVarint(buf: Uint8Array, from: number): { value: bigint; next: number } | null {
  let value = 0n;
  let shift = 0n;
  for (let i = from; i < buf.length && i - from < 10; i += 1) {
    const byte = buf[i];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  return null;
}
