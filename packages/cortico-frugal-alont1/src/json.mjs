import { readFileSync } from 'node:fs'

/** Windows UTF-8 BOM is accepted; malformed JSON remains an error. */
export function parseJson(text) { return JSON.parse(text.replace(/^\uFEFF/u, '')) }
export function readJson(file) { return parseJson(readFileSync(file, 'utf8')) }
