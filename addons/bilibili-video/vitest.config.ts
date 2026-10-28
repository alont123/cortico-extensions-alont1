import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** 开发期 `cortico/*` 由 devDependency `cortico` 解析;`pnpm link` 到本地框架时要把它放进 vite 的可服务范围。 */
const FRAMEWORK_DIR = realpathSync(dirname(createRequire(import.meta.url).resolve('cortico/package.json')));

export default defineConfig({
  server: {
    fs: { allow: [fileURLToPath(new URL('./', import.meta.url)), FRAMEWORK_DIR] },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
  },
});
