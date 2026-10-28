/** 扩展入口：默认导出 WorldDefinition。 */
export { HUMANLIKE as default, createHumanlikeWorld } from './definition.ts'
export {
  HUMANLIKE_DEFAULTS,
  HUMANLIKE_CONFIG_GROUPS,
  hoistEnabled,
  type HumanlikeConfigSection,
} from './config.ts'
export { HumanlikeWorld, type HumanlikeWorldOptions } from './world.ts'
