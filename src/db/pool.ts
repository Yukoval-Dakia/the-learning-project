import { getServerEnv } from '@/core/config/server/env';

// postgres-js 连接池上限的单一声明点。pool 构造只能重启，admin runtime facts 复用同一
// 解析结果；facts 模块不能静态 import db/client（其模块顶层读 DATABASE_URL）。
// 默认每个 app/worker 进程 10。`DB_POOL_MAX` 只在很多进程共用一个 Postgres 时下调
// （dev:local 设为 5），设了它也同时决定 pg-boss 的连接池。
function resolveDbPoolMax(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`DB_POOL_MAX must be a positive integer, got '${raw}'`);
  }
  return value;
}

export const DB_POOL_OVERRIDE = resolveDbPoolMax(getServerEnv().DB_POOL_MAX);
export const DB_POOL_MAX = DB_POOL_OVERRIDE ?? 10;
