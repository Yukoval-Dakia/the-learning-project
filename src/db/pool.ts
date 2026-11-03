// postgres-js 连接池上限的单一声明点。admin config 读面的 runtime 分区经组合根 facts seam
// 引用同一常量，而 facts 模块不能静态 import db/client（其模块顶层读 DATABASE_URL）。
// 默认每个 app/worker 进程 10。`DB_POOL_MAX` 只在很多进程共用一个 Postgres 时下调
// （dev:local 设为 5），设了它也同时决定 pg-boss 的连接池。
function poolMaxOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`DB_POOL_MAX must be a positive integer, got '${raw}'`);
  }
  return value;
}

export const DB_POOL_OVERRIDE = poolMaxOverride(process.env.DB_POOL_MAX);
export const DB_POOL_MAX = DB_POOL_OVERRIDE ?? 10;
