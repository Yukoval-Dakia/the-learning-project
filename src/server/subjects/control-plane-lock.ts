// YUK-599 (YUK-597 v3 trait 合同 §3.1 并发协议) — 控制面全局 advisory lock。
//
// 一切控制面写事务（YUK-600 thin-create、YUK-601 双写面/fork/换绑/控制行写、
// 本单 reconcileBuiltinTraits）开头执行
//   SELECT pg_advisory_xact_lock(SUBJECT_CONTROL_PLANE_LOCK)
// ——整面串行化（低频写面：单用户、日级操作数），换绑 phantom / 锁序 / 死锁
// 整类消失；事务结束自动释放。CAS（revision）保留但语义降级为「陈旧 UI 提交
// 守卫」（409），与串行化各司其职。数据面（学习流量）零涉及。

import { sql } from 'drizzle-orm';

// 常量 key：'YUK-597' 的稳定标记值。全仓唯一一把控制面锁——不要为子面派生新 key。
export const SUBJECT_CONTROL_PLANE_LOCK = 597_001;

// 事务内取锁的共用片段（drizzle tx.execute 用）。
export const acquireControlPlaneLockSql = sql`SELECT pg_advisory_xact_lock(${SUBJECT_CONTROL_PLANE_LOCK})`;
