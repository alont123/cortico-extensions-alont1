/** 扩展入口：默认导出 WorldDefinition。 */
export { LIFE as default } from './definition.ts';
export { LIFE_DEFAULTS, LIFE_CONFIG_GROUP } from './config.ts';
export { LifeWorld } from './world.ts';
export { CHAINS, MOODS, activitiesFor, slotFor, dayKindFor } from './content.ts';
export type { LifeConfigSection } from './config.ts';
export type { LifeState, LifeEvent } from './world.ts';
export type { Weighted, Slot, DayKind, EventChain, EventLink } from './content.ts';
