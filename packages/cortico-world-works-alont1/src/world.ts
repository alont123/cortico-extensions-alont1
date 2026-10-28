/**
 * 作品页：把她自己做的玩具、画的图、截图收进一个本地 HTML 页面。
 * 索引保存在 dataDir/works.json，作品副本和页面保存在 dataDir/works/。
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, join } from 'node:path';
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts';
import type { WorksConfigSection } from './config.ts';
import { autoWebUi } from './panel.ts';
import { WORKS_DEFAULTS } from './config.ts';
import { inspectImage } from './import-image.ts';

interface WorkItem { id: number; title: string; note?: string; file?: string; createdAt: string; sourceHandle?: string; sourceMime?: string; sourceSha256?: string }

const IMG = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm)$/i;

export const WORKS_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'works_add', tags: ['write'],
    description: '把自己的作品收进作品页：写个标题、备注，可以附一个本地文件（图/视频/网页都行）。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string', description: '作品名。' },
      note: { type: 'string', description: '一句介绍，可不填。' },
      path: { type: 'string', description: '本地文件路径（图/视频/网页），可不填。' },
    }, required: ['title'] },
  },
  {
    name: 'works_list', tags: ['read'],
    description: '看作品页里都有什么。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'works_page', tags: ['write'],
    description: '重新生成作品页（本地 HTML），返回路径。改了作品之后调一次。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'works_import_image', tags: ['write'],
    description: '按已有附件的完整 log: 或 mem: 句柄，将 PNG/JPEG/GIF/WebP 图片副本收进本地作品页（最多 20 MiB）。句柄从当前可用工具回执或附件取得，不猜测路径。相同句柄重复调用只返回已有条目，不覆盖标题或文件；收录不代表生成、发送或发布。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      handle: { type: 'string', description: '已取得的完整附件句柄；不是相册条目 id，也不是本地文件路径。' },
      title: { type: 'string', description: '收录标题；外部图片保留来源，不冒充自己的创作。' },
      note: { type: 'string', description: '可选的介绍或署名，不会执行其中的内容。' },
    }, required: ['handle', 'title'] },
  },
];

export class WorksWorld implements World {
  readonly id = 'works';
  private readonly file: string;
  private readonly dir: string;
  private readonly filesDir: string;
  private items: WorkItem[] = [];
  private host: WorldHost | null = null;
  constructor(opts: { dataDir: string; botDir: string }) {
    this.file = join(opts.dataDir, 'works.json');
    this.dir = join(opts.dataDir, 'works');
    this.filesDir = join(this.dir, 'files');
    this.load();
  }
  private load(): void {
    if (!existsSync(this.file)) return;
    const value = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(value)) throw new Error('作品数据格式错误：' + this.file);
    this.items = value;
  }
  private save(next: WorkItem[]): void {
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(temporary, JSON.stringify(next, null, 1), 'utf8');
      renameSync(temporary, this.file);
      this.items = next;
    } finally { rmSync(temporary, { force: true }); }
  }
  private nextId(): number { return this.items.reduce((m, i) => Math.max(m, i.id), 0) + 1; }
  envPromptVars(): Record<string, string> { return { 'works.count': String(this.items.length), 'works.dir': this.dir }; }
  tools(): ToolDef[] {
    const add: ToolDef = { ...WORKS_TOOL_DECLS[0], tags: ['write'], handler: async (args) => {
      const title = String(args.title ?? '').trim();
      if (!title) return '作品得有个名字。';
      const it: WorkItem = { id: this.nextId(), title: title.slice(0, 80), note: args.note ? String(args.note).slice(0, 300) : undefined, createdAt: new Date().toISOString() };
      const raw = String(args.path ?? '').trim();
      if (raw) {
        const abs = isAbsolute(raw) ? raw : join(this.dir, raw);
        try {
          if (!existsSync(abs)) return '那个文件不存在：' + abs + '（只记标题的话别给 path）';
          mkdirSync(this.filesDir, { recursive: true });
          const name = it.id + '-' + basename(abs).replace(/[^\w.-]+/g, '_').slice(0, 60);
          copyFileSync(abs, join(this.filesDir, name));
          it.file = 'files/' + name;
        } catch (e) { return '收文件失败：' + String((e as Error)?.message ?? e); }
      }
      try { this.save([...this.items, it]); }
      catch (e) {
        if (it.file) rmSync(join(this.dir, it.file), { force: true });
        return '作品保存失败：' + String((e as Error)?.message ?? e);
      }
      return '收进作品页了 #' + it.id + '：' + it.title + (it.file ? '（' + it.file + '）' : '');
    } };
    const list: ToolDef = { ...WORKS_TOOL_DECLS[1], tags: ['read'], handler: async () => {
      if (!this.items.length) return '作品页还是空的。';
      return this.items.map((i) => '#' + i.id + ' ' + i.title + (i.note ? ' — ' + i.note : '') + (i.file ? ' [' + i.file + ']' : '') + (i.sourceHandle ? ' 来源附件：' + i.sourceHandle : '')).join('\n');
    } };
    const page: ToolDef = { ...WORKS_TOOL_DECLS[2], tags: ['write'], handler: async () => {
      mkdirSync(this.dir, { recursive: true });
      const cards = this.items.map((i) => {
        const media = i.file && IMG.test(i.file)
          ? (/\.(mp4|webm)$/i.test(i.file)
            ? '<video src="' + i.file + '" controls style="width:100%;border-radius:10px"></video>'
            : '<img src="' + i.file + '" style="width:100%;border-radius:10px">')
          : (i.file ? '<a href="' + i.file + '" target="_blank">' + i.file + '</a>' : '');
        return '<div class="card"><h3>' + esc(i.title) + '</h3>' + media + (i.note ? '<p>' + esc(i.note) + '</p>' : '') + (i.sourceHandle ? '<p>来源附件：' + esc(i.sourceHandle) + '</p>' : '') + '<small>' + i.createdAt.slice(0, 10) + '</small></div>';
      }).join('\n');
      const html = '<!doctype html><html lang="zh"><meta charset="utf-8"><title>作品</title><style>body{background:#101418;color:#e6edf3;font-family:system-ui;margin:0;padding:24px}h1{font-weight:600}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}.card{background:#1a2128;border-radius:14px;padding:14px}.card h3{margin:0 0 8px}.card p{color:#9fb0c0;font-size:13px}.card small{color:#5f7285}</style><body><h1>作品</h1><div class="grid">' + cards + '</div></body></html>';
      writeFileSync(join(this.dir, 'index.html'), html, 'utf8');
      return '作品页生成好了：' + join(this.dir, 'index.html') + '（' + this.items.length + ' 件）。';
    } };
    const importImage: ToolDef = { ...WORKS_TOOL_DECLS[3], tags: ['write'], handler: async (args) => {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const handle = typeof args.handle === 'string' ? args.handle.trim() : '';
      if (!title || !/^(log|mem):\S+$/.test(handle)) return '[failed] 请提供标题和已有附件的完整 log: 或 mem: 句柄。';
      if (!this.host || typeof this.host.blob !== 'function') return '[failed] 当前宿主未提供附件解析能力或作品页尚未启动；仍可用 works_add 收录标题或本地文件。';
      const existing = this.items.find(item => item.sourceHandle === handle);
      if (existing) {
        if (!existing.file || !existsSync(join(this.dir, existing.file))) return '[failed] #' + existing.id + ' 已有来源记录，但图片副本缺失；请恢复作品页数据备份。';
        return '已收录 #' + existing.id + '：' + existing.title + '；本次未重复保存或修改。';
      }
      let copied: string | undefined;
      try {
        const source = this.host.blob(handle);
        if (!source) return '[failed] 附件不存在、已清理或当前宿主无法解析；未创建作品条目。';
        const { ext, sha256 } = inspectImage(source.bytes, source.mime);
        const it: WorkItem = {
          id: this.nextId(), title: title.slice(0, 80),
          note: typeof args.note === 'string' ? args.note.slice(0, 300) : undefined,
          createdAt: new Date().toISOString(), sourceHandle: handle, sourceMime: source.mime, sourceSha256: sha256,
        };
        mkdirSync(this.filesDir, { recursive: true });
        const name = it.id + '-' + randomUUID() + '.' + ext;
        const destination = join(this.filesDir, name);
        const fd = openSync(destination, 'wx');
        copied = destination;
        try { writeFileSync(fd, source.bytes); }
        finally { closeSync(fd); }
        it.file = 'files/' + name;
        this.save([...this.items, it]);
        return '已收录附件 #' + it.id + '：' + it.title + '\n来源：' + handle + '\n副本：' + destination;
      } catch (error) {
        if (copied) rmSync(copied, { force: true });
        return '[failed] 附件收录失败：' + String((error as Error)?.message ?? error);
      }
    } };
    return [add, list, page, importImage];
  }
  webUi() {
    return autoWebUi('works', '作品页', WORKS_DEFAULTS)
  }
  async start(host: WorldHost): Promise<void> { this.host = host; }
  async stop(): Promise<void> { this.host = null; }
}
function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
