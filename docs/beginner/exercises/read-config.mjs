import { readFileSync } from 'node:fs';

try {
  const raw = readFileSync(new URL('./sample.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
  let config;
  try { config = JSON.parse(raw); }
  catch { throw new Error('JSON 格式不正确，请检查双引号、逗号和括号。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.enabled !== 'boolean'
    || typeof config.greeting !== 'string'
    || !Number.isFinite(config.gapMinutes) || config.gapMinutes <= 0) {
    throw new Error('配置类型不正确：enabled 要用 true/false，greeting 要用文字，gapMinutes 要用大于 0 的数字。');
  }
  console.log('配置读取成功');
  console.log('功能已启用：' + config.enabled);
  console.log('示例问候：' + config.greeting);
  console.log('提醒间隔（分钟）：' + config.gapMinutes);
} catch (error) {
  console.error('练习未完成：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
