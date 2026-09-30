// YUK-1007 — postgres-js 连接池上限的单一声明点。抽成独立小模块（无 env 读取、
// 无副作用）：admin config 读面的 runtime 分区经组合根 facts seam 引用同一常量，
// 而 facts 模块不能静态 import db/client（其模块顶层读 DATABASE_URL，必须在
// loadEnv 之后加载）。值与原内联 `max: 10` 逐字一致。
export const DB_POOL_MAX = 10; // pool size per app/worker process
