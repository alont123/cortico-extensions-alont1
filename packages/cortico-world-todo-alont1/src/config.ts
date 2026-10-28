/** 任务板配置。 */
export interface TodoConfigSection { enabled: boolean; }
export const TODO_DEFAULTS: TodoConfigSection = { enabled: false };
export function normalizeTodoConfig(raw: unknown): TodoConfigSection {
  const c = { ...TODO_DEFAULTS };
  if (raw && typeof raw === 'object' && typeof (raw as any).enabled === 'boolean') c.enabled = (raw as any).enabled;
  return c;
}
