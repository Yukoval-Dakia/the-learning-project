// 控制面全局 advisory lock。所有控制面写事务开头取它，把低频写面整体串行化，
// 消掉换绑 phantom、锁序与死锁；事务结束自动释放。CAS（revision）仍保留，但只
// 作为陈旧 UI 提交的守卫（409）。数据面（学习流量）不涉及。

import { sql } from 'drizzle-orm';

// 稳定 key。全仓唯一一把控制面锁——不要为子面派生新 key。
export const SUBJECT_CONTROL_PLANE_LOCK = 597_001;

// 事务内取锁的共用片段。
export const acquireControlPlaneLockSql = sql`SELECT pg_advisory_xact_lock(${SUBJECT_CONTROL_PLANE_LOCK})`;
