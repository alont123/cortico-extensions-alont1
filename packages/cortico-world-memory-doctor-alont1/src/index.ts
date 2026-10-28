/** 扩展入口：默认导出 WorldDefinition。 */
export { MEMORY_DOCTOR as default } from './definition.ts';
export {
  MEMORY_DOCTOR_DEFAULTS,
  MEMORY_DOCTOR_CONFIG_GROUP,
  type MemoryDoctorConfigSection,
} from './config.ts';
export { MemoryDoctorWorld, type MemoryDoctorOptions } from './world.ts';
export { examine, renderReport, estimateTokens, type MemoryReport } from './examine.ts';
