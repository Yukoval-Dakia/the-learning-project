// M0 (YUK-313) — 零依赖 env 加载：解析 .env → .env.local（后者优先），
// 只填尚未设置的变量（真实环境/compose 注入的值永远赢）。不赌 tsx --env-file
// 的版本兼容性；支持引号值与行尾注释剥离（.env.local 的 DATABASE_URL 实际
// 带行尾注释，已踩过坑）。

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseLine(line: string): [string, string] | null {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  let value = m[2].trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    value = end > 0 ? value.slice(1, end) : value.slice(1);
  } else {
    // 未加引号的值：剥行尾注释。
    const hash = value.indexOf(' #');
    if (hash >= 0) value = value.slice(0, hash);
    value = value.trim();
  }
  return [m[1], value];
}

export function loadEnv(rootDir: string = process.cwd()): void {
  // .env 先、.env.local 后——但都「只填空位」，所以 .env.local 想赢必须在
  // process.env 里还没有该 key 时先到。这里按覆盖优先级倒序读：local 先填。
  for (const file of ['.env.local', '.env']) {
    const path = resolve(rootDir, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line || line.trimStart().startsWith('#')) continue;
      const kv = parseLine(line);
      if (kv && process.env[kv[0]] === undefined) process.env[kv[0]] = kv[1];
    }
  }
}
