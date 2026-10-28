import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { TODO_DEFAULTS, normalizeTodoConfig, type TodoConfigSection } from './config.ts';
import { TODO_TOOL_DECLS, TodoWorld } from './world.ts';
export const definition: WorldDefinition<TodoConfigSection> = withWorldPanel({
  id: 'todo', label: '任务板',
  defaults: () => ({ ...TODO_DEFAULTS }),
  create: (ctx) => new TodoWorld({ dataDir: ctx.dataDir }),
  describe: { tools: describeTools(TODO_TOOL_DECLS, {
    todo_add: { zh: '记一条要做的事', en: 'Add a todo' },
    todo_list: { zh: '看任务板', en: 'List todos' },
    todo_done: { zh: '标记完成', en: 'Mark done' },
    todo_remove: { zh: '删一条', en: 'Remove a todo' },
  }), events: [] },
}, PANEL_GUIDE);
