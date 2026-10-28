/** 扩展入口：默认导出 WorldDefinition。 */
export { CLOCK as default, createClockWorld } from './definition.ts'
export { CLOCK_DEFAULTS, CLOCK_CONFIG_GROUP } from './config.ts'
export { ClockWorld } from './world.ts'
export {
  periodOf, PERIOD_STARTS, PERIOD_NOTES,
  clockLine, chineseDate, clockOf, dayProgress, humanMinutes,
} from './clock.ts'
export type { ClockConfigSection, ClockAnnounce } from './config.ts'
export type { PeriodName } from './clock.ts'
