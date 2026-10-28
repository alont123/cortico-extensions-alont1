/** Bounded read-only file metrics; Persona prefix membership is supplied explicitly. */
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sourceFiles } from './source-files.ts';

/** 一份文件的体检结果。 */
export interface FileVitals {
  /** 工作区内的相对路径。 */
  path: string;
  bytes: number;
  lines: number;
  /** token 估算：中文按 1 字 ≈ 1.1 token，英文按 4 字符 ≈ 1 token，取折中。 */
  tokens: number;
  modifiedAt: string;
}

export interface Duplicate {
  /** 重复的那句话的前若干字。 */
  snippet: string;
  /** 出现在哪几份文件里。 */
  files: string[];
}

export interface MemoryReport {
  /** 工作区里所有文件的体检（不含 blobs）。 */
  files: FileVitals[];
  /** 由操作者明确指定的常驻文件。 */
  resident: FileVitals[];
  residentTokens: number;
  /** 交接笔记的份数与总体积。 */
  handoffs: { count: number; bytes: number; newest?: string; oldest?: string };
  /** 按目录分的体积。 */
  byDir: Array<{ dir: string; files: number; bytes: number }>;
  /** 跟上次体检比，长大了多少（第一次体检时为空）。 */
  growth: Array<{ path: string; bytes: number; delta: number }>;
  /** 疑似重复的句子。 */
  duplicates: Duplicate[];
}

export function estimateTokens(text: string): number {
  // 中文字符按 1.05 token、其余按 4 字符 1 token 估。够用来判断量级。
  let cjk = 0;
  for (const ch of text) if (ch >= '\u4e00' && ch <= '\u9fff') cjk++;
  const rest = text.length - cjk;
  return Math.round(cjk * 1.05 + rest / 4);
}

function vitalsOf(root: string, rel: string): FileVitals | null {
  try {
    const full = join(root, rel);
    const st = statSync(full);
    // 只体检文本；二进制（图片、音频）跳过——它们的体积不是"记忆变胖"。
    if (st.size > 4 * 1024 * 1024) return null;
    const text = readFileSync(full, 'utf8');
    if (text.includes('\u0000')) return null;
    return {
      path: rel,
      bytes: st.size,
      lines: text.split('\n').length,
      tokens: estimateTokens(text),
      modifiedAt: st.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/** 把正文切成句子，找"一样的话出现在多份文件里"。 */
function sentencesOf(text: string): string[] {
  return text
    .split(/[\n。！？!?；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18 && s.length <= 200)
    // 框架写进交接笔记的机制说明：每份都有，报出来没意义
    .filter((s) => !/(上下文已经全部清空|交接会把上文全部清空|对外发言类调用已整条省略|重复了 \d+ 次|工具调用与回执)/.test(s));
}

export interface DoctorOptions {
  /** 工作区目录 = 记忆。 */
  memoryDir: string;
  residentFiles?: string[];
  residentWarnTokens: number;
  handoffsWarnCount: number;
  deepScanFiles: number;
  /** 上次体检的结果（存在 dataDir 里），用来算增速。 */
  previous?: { at: string; files: Record<string, number> } | null;
}

export function examine(opts: DoctorOptions): MemoryReport {
  const rels = sourceFiles(opts.memoryDir);
  const files: FileVitals[] = [];
  for (const rel of rels) {
    const v = vitalsOf(opts.memoryDir, rel);
    if (v) files.push(v);
  }
  files.sort((a, b) => b.bytes - a.bytes);

  const resident = files.filter((f) => (opts.residentFiles ?? []).includes(f.path));
  const residentTokens = resident.reduce((sum, f) => sum + f.tokens, 0);

  // 交接笔记：目录名按约定是 handoffs/
  const handoffFiles = files.filter((f) => f.path.startsWith('handoffs/'));
  const handoffTimes = handoffFiles.map((f) => f.modifiedAt).sort();
  const handoffs = {
    count: handoffFiles.length,
    bytes: handoffFiles.reduce((sum, f) => sum + f.bytes, 0),
    ...(handoffTimes.length ? { oldest: handoffTimes[0]!, newest: handoffTimes[handoffTimes.length - 1]! } : {}),
  };

  const dirMap = new Map<string, { files: number; bytes: number }>();
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '(根目录)';
    const cur = dirMap.get(dir) ?? { files: 0, bytes: 0 };
    cur.files++;
    cur.bytes += f.bytes;
    dirMap.set(dir, cur);
  }
  const byDir = [...dirMap.entries()]
    .map(([dir, v]) => ({ dir, ...v }))
    .sort((a, b) => b.bytes - a.bytes);

  // 增速：跟上次体检比（只报变化超过 1KB 的，免得噪声）
  const growth: Array<{ path: string; bytes: number; delta: number }> = [];
  if (opts.previous) {
    for (const f of files) {
      const before = opts.previous.files[f.path];
      if (before === undefined) {
        if (f.bytes > 2048) growth.push({ path: f.path, bytes: f.bytes, delta: f.bytes });
        continue;
      }
      const delta = f.bytes - before;
      if (Math.abs(delta) > 1024) growth.push({ path: f.path, bytes: f.bytes, delta });
    }
  }
  growth.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // 重复：只细看最大的那几个文件，避免每次体检把整个工作区读两遍
  const deep = files.slice(0, Math.max(1, opts.deepScanFiles));
  const index = new Map<string, Set<string>>();
  for (const f of deep) {
    let text = '';
    try {
      text = readFileSync(join(opts.memoryDir, f.path), 'utf8');
    } catch {
      continue;
    }
    for (const s of new Set(sentencesOf(text))) {
      const set = index.get(s) ?? new Set<string>();
      set.add(f.path);
      index.set(s, set);
    }
  }
  // 过半文件都有的句子是**模板**（比如交接笔记每份开头都有的那几行），不是复制粘贴的影子。
  // 报出来只会淹没有用的信息，所以按比例滤掉。
  const templateCutoff = Math.max(2, Math.ceil(deep.length * 0.5));
  const duplicates: Duplicate[] = [];
  for (const [snippet, set] of index) {
    if (set.size < 2 || set.size >= templateCutoff) continue;
    // 真正的"影子"是跨**不同种类**的文件：同一句话既在记忆里、又在笔记里。
    // 落在同一个目录里的（比如两份流水都写了同一件事）当正常现象，不报。
    const dirs = new Set([...set].map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '(根目录)')));
    if (dirs.size < 2) continue;
    duplicates.push({ snippet: snippet.slice(0, 60), files: [...set].sort() });
  }
  duplicates.sort((a, b) => b.files.length - a.files.length);

  return {
    files,
    resident,
    residentTokens,
    handoffs,
    byDir,
    growth,
    duplicates: duplicates.slice(0, 20),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/** 把体检结果写成给人看的一段。 */
export function renderReport(r: MemoryReport, limits: DoctorOptions): string {
  const lines: string[] = [];
  const totalBytes = r.files.reduce((s, f) => s + f.bytes, 0);
  lines.push(`记忆体检：${r.files.length} 份文本、共 ${formatBytes(totalBytes)}`);

  // ① 常驻档
  lines.push('');
  const overWarn = r.residentTokens > limits.residentWarnTokens;
  lines.push(`【明确指定的常驻文件估算】${r.residentTokens} tok${overWarn ? ` ⚠ 超过提醒线 ${limits.residentWarnTokens}` : ''}`);
  for (const f of r.resident) {
    lines.push(`  · ${f.path}  ${formatBytes(f.bytes)}  ${f.tokens} tok  ${f.lines} 行  改于 ${f.modifiedAt.slice(0, 10)}`);
  }
  if (r.resident.length === 0) lines.push('  （未指定常驻文件，或指定文件未被读取；扩展不推断 Persona 前缀）');
  if (overWarn) {
    lines.push('  → 超过配置提醒线；请由 Persona 核对实际前缀是否包含这些文件，再决定是否整理。');
  }

  // ② 交接笔记
  lines.push('');
  const handoffWarn = r.handoffs.count > limits.handoffsWarnCount;
  lines.push(`【交接笔记】${r.handoffs.count} 份、${formatBytes(r.handoffs.bytes)}${handoffWarn ? ` ⚠ 超过提醒线 ${limits.handoffsWarnCount}` : ''}`);
  if (r.handoffs.count > 0) {
    lines.push(`  · 最早 ${r.handoffs.oldest?.slice(0, 10)}  最近 ${r.handoffs.newest?.slice(0, 10)}`);
  }
  if (handoffWarn) lines.push('  → 攒太多会互相淹没。旧的那些压成一份年表，或者挑要紧的挪进 memories/。');

  // ③ 目录分布
  lines.push('');
  lines.push('【都在哪儿】');
  for (const d of r.byDir.slice(0, 8)) lines.push(`  · ${d.dir}  ${d.files} 份  ${formatBytes(d.bytes)}`);

  // ④ 增速
  if (r.growth.length > 0) {
    lines.push('');
    lines.push('【跟上次比，哪几份在长】');
    for (const g of r.growth.slice(0, 8)) {
      const sign = g.delta >= 0 ? '+' : '';
      lines.push(`  · ${g.path}  ${sign}${formatBytes(Math.abs(g.delta))} → 现在 ${formatBytes(g.bytes)}`);
    }
  }

  // ⑤ 重复
  if (r.duplicates.length > 0) {
    lines.push('');
    lines.push(`【同一句话出现在多份文件里】${r.duplicates.length} 处（可能是复制粘贴留下的影子）`);
    for (const d of r.duplicates.slice(0, 5)) {
      lines.push(`  · 「${d.snippet}…」在 ${d.files.length} 份里：${d.files.map((f) => basename(f)).join('、')}`);
    }
  }

  return lines.join('\n');
}
