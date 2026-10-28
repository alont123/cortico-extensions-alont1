/** 记忆体检扩展的配置段：worlds.memory-doc。 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface MemoryDoctorConfigSection {
  enabled: boolean;
  /** Explicit read-only source directory. */
  sourceDir: string;
  /** JSON array of explicitly selected resident file paths. */
  residentFilesJson: string;
  /** Explicitly selected resident files: character-based estimate threshold. */
  residentWarnTokens: number;
  /** 交接笔记攒到多少份就该整理了。 */
  handoffsWarnCount: number;
  /** 体检时最多细看多少个文件（按体积从大到小）。 */
  deepScanFiles: number;
  /** Legacy alias for sourceDir; empty values do not discover a Persona directory. */
  memoryDir: string;
}

export const MEMORY_DOCTOR_DEFAULTS: MemoryDoctorConfigSection = {
  enabled: false,
  sourceDir: '',
  residentFilesJson: '[]',
  residentWarnTokens: 24000,
  handoffsWarnCount: 200,
  deepScanFiles: 40,
  memoryDir: '',
};

export const MEMORY_DOCTOR_CONFIG_GROUP: ConfigGroup = {
  id: 'world:memory-doc',
  owner: 'world:memory-doc',
  schema: {
    type: 'object',
    title: '记忆体检',
    description: '只读体检明确配置的资料目录；不识别 Persona 的 Memory 或判断哪些文件实际进入模型前缀。',
    properties: {
      'worlds.memory-doc.sourceDir': { type: 'string', title: '资料目录', 'x-hot': false, 'x-path': { kind: 'directory' }, description: '必须明确填写；相对部署目录或绝对路径。留空不自动读取。旧 memoryDir 的显式值仍兼容。' },
      'worlds.memory-doc.residentFilesJson': { type: 'string', title: '需单独统计的常驻文件', 'x-hot': false, description: 'JSON 相对路径数组，例如 ["CONSTITUTION.md"]。默认 []；是否实际进入前缀由 Persona 决定，扩展只报告估算字数。' },
      'worlds.memory-doc.residentWarnTokens': {
        type: 'integer', title: '常驻档提醒线', minimum: 2000, maximum: 200000,
        'x-suffix': 'tok', 'x-hot': true,
        description: '明确配置的常驻文件超过这个估算值就提示；不是实际 Token 用量或模型费用。',
      },
      'worlds.memory-doc.handoffsWarnCount': {
        type: 'integer', title: '交接笔记提醒线', minimum: 20, maximum: 5000,
        'x-suffix': '份', 'x-hot': true,
        description: '攒到这么多份就该整理了。',
      },
      'worlds.memory-doc.deepScanFiles': {
        type: 'integer', title: '细看几个文件', minimum: 5, maximum: 200,
        'x-hot': true,
        description: '体检时按体积从大到小细看几个（找重复段落）。调大更慢。',
      },
      'worlds.memory-doc.memoryDir': {
        type: 'string', title: '旧版资料目录（兼容）', 'x-hot': false, 'x-path': { kind: 'directory' },
        description:
          'sourceDir 留空时使用此显式值；两者都空时不扫描。建议改用 sourceDir。',
      },
    },
  },
};
