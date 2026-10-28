/**
 * 任务板：让她把「答应了谁什么、什么时候要做」记成条目，而不是散在笔记里。
 * 存储：<dataDir>/todo.json。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolDef, World } from 'cortico/core/types.ts';
import type { TodoConfigSection } from './config.ts';
import { autoWebUi } from './panel.ts';
import { TODO_DEFAULTS } from './config.ts';

interface TodoItem { id: number; text: string; due?: string; done: boolean; createdAt: string; doneAt?: string }

export const TODO_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'todo_add', tags: ['write'],
    description: '往任务板记一条要做的事（答应谁的、哪天要做的）。due 可以不填。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      text: { type: 'string', description: '要做的事，一句话。' },
      due: { type: 'string', description: '什么时候要（如 明早5点 / 10-20 晚上），可不填。' },
    }, required: ['text'] },
  },
  {
    name: 'todo_list', tags: ['read'],
    description: '看任务板：还没做的都在，按记下的顺序。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      all: { type: 'boolean', description: 'true 连做完的一起看。' },
    } },
  },
  {
    name: 'todo_done', tags: ['write'],
    description: '把某条标记成做完了（要 id，来自 todo_list）。',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', description: '条目 id。' } }, required: ['id'] },
  },
  {
    name: 'todo_remove', tags: ['write'],
    description: '删掉某条（不想做了/记错了）。',
    parameters: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer', description: '条目 id。' } }, required: ['id'] },
  },
];

export class TodoWorld implements World {
  readonly id = 'todo';
  private readonly file: string;
  private items: TodoItem[] = [];
  constructor(opts: { dataDir: string }) {
    this.file = join(opts.dataDir, 'todo.json');
    this.load();
  }
  private load(): void {
    if (!existsSync(this.file)) return;
    const value = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(value)) throw new Error('任务板数据格式错误：' + this.file);
    this.items = value;
  }
  private save(next: TodoItem[]): void {
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(temporary, JSON.stringify(next, null, 1), 'utf8');
      renameSync(temporary, this.file);
      this.items = next;
    } finally { rmSync(temporary, { force: true }); }
  }
  private nextId(): number { return this.items.reduce((m, i) => Math.max(m, i.id), 0) + 1; }
  envPromptVars(): Record<string, string> { return { 'todo.open': String(this.items.filter((i) => !i.done).length) }; }
  tools(): ToolDef[] {
    const add: ToolDef = { ...TODO_TOOL_DECLS[0], tags: ['write'], handler: async (args) => {
      const text = String(args.text ?? '').trim();
      if (!text) return '要记什么？给一句话。';
      const it: TodoItem = { id: this.nextId(), text: text.slice(0, 200), due: args.due ? String(args.due).slice(0, 40) : undefined, done: false, createdAt: new Date().toISOString() };
      try { this.save([...this.items, it]); }
      catch (e) { return '任务保存失败：' + String((e as Error)?.message ?? e); }
      return '记下了 #' + it.id + '：' + it.text + (it.due ? '（' + it.due + '）' : '');
    } };
    const list: ToolDef = { ...TODO_TOOL_DECLS[1], tags: ['read'], handler: async (args) => {
      const all = args.all === true;
      const shown = this.items.filter((i) => all || !i.done);
      if (!shown.length) return all ? '任务板是空的。' : '没有没做完的事。';
      return shown.map((i) => (i.done ? '[x]' : '[ ]') + ' #' + i.id + ' ' + i.text + (i.due ? ' — ' + i.due : '')).join('\n');
    } };
    const done: ToolDef = { ...TODO_TOOL_DECLS[2], tags: ['write'], handler: async (args) => {
      const id = Number(args.id);
      const it = this.items.find((i) => i.id === id);
      if (!it) return '没有 #' + id + ' 这条。先 todo_list 看看。';
      try { this.save(this.items.map((item) => item.id === id ? { ...item, done: true, doneAt: new Date().toISOString() } : item)); }
      catch (e) { return '任务保存失败：' + String((e as Error)?.message ?? e); }
      return '好，#' + id + ' 做完了。';
    } };
    const remove: ToolDef = { ...TODO_TOOL_DECLS[3], tags: ['write'], handler: async (args) => {
      const id = Number(args.id);
      const n = this.items.length;
      const next = this.items.filter((i) => i.id !== id);
      if (next.length === n) return '没有 #' + id + ' 这条。';
      try { this.save(next); }
      catch (e) { return '任务保存失败：' + String((e as Error)?.message ?? e); }
      return '删了 #' + id + '。';
    } };
    return [add, list, done, remove];
  }
  webUi() {
    return autoWebUi('todo', '任务板', TODO_DEFAULTS)
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
