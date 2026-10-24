// orchestrator 调度态存取（dag_orchestration_run / _node）。
//
// 控制面记录，与 event 数据面物理隔离。每个非平凡列都显式写（audit:schema
// write-path 契约）。

import { and, desc, eq, notInArray } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { dag_orchestration_node, dag_orchestration_run } from '@/db/schema';

/** 需要在调用方事务里链式写入时用 Tx。 */
type DbOrTx = Db | Tx;

export type RunTrigger = 'cron' | 'manual';
export type RunStatus = 'running' | 'completed' | 'abandoned';
export type NodeStatus =
  | 'pending'
  | 'enqueued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'not_needed'
  | 'degraded';

export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'succeeded',
  'failed',
  'skipped',
  'not_needed',
  'degraded',
]);

export function isTerminalNodeStatus(status: NodeStatus): boolean {
  return TERMINAL_NODE_STATUSES.has(status);
}

export interface RunRow {
  id: string;
  run_date: string;
  trigger: RunTrigger;
  status: RunStatus;
  started_at: Date;
  finished_at: Date | null;
}

export interface NodeRow {
  id: string;
  run_id: string;
  job_name: string;
  status: NodeStatus;
  boss_job_id: string | null;
  stale: boolean;
  detail: string | null;
  enqueued_at: Date | null;
  finished_at: Date | null;
}

/**
 * 起一条今晚 run。partial unique(run_date) where status='running' 兜单飞：并发 start
 * （cron vs manual / 双 worker）第二次撞 ON CONFLICT DO NOTHING → 返回 null，调用方转为
 * 推进既有 run。
 */
export async function createRun(
  db: DbOrTx,
  input: { runDate: string; trigger: RunTrigger; now?: Date },
): Promise<RunRow | null> {
  const now = input.now ?? new Date();
  const rows = await db
    .insert(dag_orchestration_run)
    .values({
      id: newId(),
      run_date: input.runDate,
      trigger: input.trigger,
      status: 'running',
      started_at: now,
      updated_at: now,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ? toRunRow(rows[0]) : null;
}

/**
 * 按 id 取仍在 running 的 run。tick 用自带的 run_id 定位而非按「当前本地日」反查：
 * 跨本地午夜的 run（如临近 00:00 手工起的整链重跑）换日后会查不到自己，tick 直接返回，
 * 剩余节点停摆到次夜锚点 abandon。
 */
export async function getActiveRunById(db: Db, runId: string): Promise<RunRow | null> {
  const rows = await db
    .select()
    .from(dag_orchestration_run)
    .where(and(eq(dag_orchestration_run.id, runId), eq(dag_orchestration_run.status, 'running')))
    .limit(1);
  return rows[0] ? toRunRow(rows[0]) : null;
}

export async function getActiveRunForDate(db: Db, runDate: string): Promise<RunRow | null> {
  const rows = await db
    .select()
    .from(dag_orchestration_run)
    .where(
      and(eq(dag_orchestration_run.run_date, runDate), eq(dag_orchestration_run.status, 'running')),
    )
    .limit(1);
  return rows[0] ? toRunRow(rows[0]) : null;
}

/** 全部 active（running）run（跨日）——用于锚点起步时收尾过期残留 run。 */
export async function listActiveRuns(db: Db): Promise<RunRow[]> {
  const rows = await db
    .select()
    .from(dag_orchestration_run)
    .where(eq(dag_orchestration_run.status, 'running'));
  return rows.map(toRunRow);
}

/**
 * 今日**任意状态**的最近一条 run（含 completed/abandoned）。cron 触发用它防 redeliver
 * 重建第二条 run——重投递会绕过 running-only 单飞。
 */
export async function getLatestRunForDate(db: Db, runDate: string): Promise<RunRow | null> {
  const rows = await db
    .select()
    .from(dag_orchestration_run)
    .where(eq(dag_orchestration_run.run_date, runDate))
    .orderBy(desc(dag_orchestration_run.started_at))
    .limit(1);
  return rows[0] ? toRunRow(rows[0]) : null;
}

/**
 * 收尾一条 run。**返回本次调用是否真的完成了那次转移**：调用方据它决定要不要打「今夜
 * 收尾」日志。守卫是 CAS，输的一方影响 0 行却同样 resolve——若无返回值，两个并发
 * finalizer（两条 advanceAndContinue 同时判 complete，或 start 正 abandon 而 tick 恰好
 * 判完）会各打一行「run completed」，而事实上只发生了一次收尾。日志是唯一的诊断
 * 出口，宁可少打也不能打出不存在的事件。
 */
export async function finishRun(
  db: Db,
  runId: string,
  status: 'completed' | 'abandoned',
  now = new Date(),
): Promise<boolean> {
  // Guard status='running': concurrent finalizers (two advanceAndContinue evaluating
  // complete, or a start abandoning while a tick completes) become an atomic CAS —
  // only the first transition wins, no finished_at overwrite, no running↔terminal thrash.
  const rows = await db
    .update(dag_orchestration_run)
    .set({ status, finished_at: now, updated_at: now })
    .where(and(eq(dag_orchestration_run.id, runId), eq(dag_orchestration_run.status, 'running')))
    .returning({ id: dag_orchestration_run.id });
  return rows.length > 0;
}

/** 批量落节点行（全 pending）。unique(run_id, job_name) + onConflictDoNothing 使其幂等：
 *  重复调用/补齐缺失节点安全（自愈 0 节点 run）。 */
export async function insertNodes(
  db: DbOrTx,
  runId: string,
  jobNames: readonly string[],
  now = new Date(),
): Promise<void> {
  if (jobNames.length === 0) return;
  await db
    .insert(dag_orchestration_node)
    .values(
      jobNames.map((job_name) => ({
        id: newId(),
        run_id: runId,
        job_name,
        status: 'pending' as NodeStatus,
        stale: false,
        updated_at: now,
      })),
    )
    .onConflictDoNothing();
}

/**
 * 原子建 run + 落全部节点：createRun 与 insertNodes 同一事务，杜绝「createRun 已提交、
 * insertNodes 前崩溃」留下的 0 节点 run（会让 tick 永远自转不 enqueue）。createRun 撞单飞
 * 返回 null → 事务内不插节点、返回 null，调用方转为采纳赢家的 run。
 */
export async function createRunWithNodes(
  db: Db,
  input: { runDate: string; trigger: RunTrigger; jobNames: readonly string[]; now?: Date },
): Promise<RunRow | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const run = await createRun(tx, { runDate: input.runDate, trigger: input.trigger, now });
    if (!run) return null;
    await insertNodes(tx, run.id, input.jobNames, now);
    return run;
  });
}

export async function loadNode(db: Db, nodeId: string): Promise<NodeRow | null> {
  const [row] = await db
    .select()
    .from(dag_orchestration_node)
    .where(eq(dag_orchestration_node.id, nodeId))
    .limit(1);
  return row ? toNodeRow(row) : null;
}

export async function loadNodes(db: Db, runId: string): Promise<Map<string, NodeRow>> {
  const rows = await db
    .select()
    .from(dag_orchestration_node)
    .where(eq(dag_orchestration_node.run_id, runId));
  const map = new Map<string, NodeRow>();
  for (const r of rows) map.set(r.job_name, toNodeRow(r));
  return map;
}

/**
 * 原子领取一个 pending 节点用于入队（CAS pending→enqueued）。true = 本调用抢到（后续负责
 * boss.send）；false = 已被并发 advanceRun（cron vs manual 同分钟）抢走，调用方跳过、绝不
 * 重复付费入队——只有赢家发付费 job。
 *
 * `boss_job_id` 由调用方**预生成**（pg-boss job.id 是 uuid 主键，send 支持 options.id），
 * 与 CAS 同一条 UPDATE 落库：send 之前该节点的 pg-boss 身份已持久化，所以「send 已成功、
 * 回填前崩溃」的窗口不存在，重投递的 orchestrator 总能查到真实 job 态，不会把在跑的成员
 * 误判超时 failed。
 */
export async function claimNodePending(
  db: Db,
  nodeId: string,
  input: { bossJobId: string; stale: boolean; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(dag_orchestration_node)
    .set({
      status: 'enqueued',
      boss_job_id: input.bossJobId,
      stale: input.stale,
      enqueued_at: now,
      updated_at: now,
    })
    .where(and(eq(dag_orchestration_node.id, nodeId), eq(dag_orchestration_node.status, 'pending')))
    .returning({ id: dag_orchestration_node.id });
  return rows.length > 0;
}

/** 资格跳过只从 pending 落 not_needed；在途节点（enqueued/running）不是本 CAS 的对象。 */
export async function claimNodeNotNeeded(
  db: Db,
  nodeId: string,
  input: { detail: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await db
    .update(dag_orchestration_node)
    .set({
      status: 'not_needed',
      detail: input.detail,
      finished_at: now,
      updated_at: now,
    })
    .where(and(eq(dag_orchestration_node.id, nodeId), eq(dag_orchestration_node.status, 'pending')))
    .returning({ id: dag_orchestration_node.id });
  return rows.length > 0;
}

/**
 * 更新节点状态（running 中间态 / 终态 succeeded|failed|skipped + detail）。
 *
 * **返回本次调用是否真的写动了那一行**：下面的终态守卫是 CAS，陈旧/并发调用会影响 0 行
 * 却照样 resolve。调用方（`settleNode`）据此只为**真实发生过**的转移打日志——否则两条
 * 并发 tick 会各打一行「node X failed」，或者一条被守卫挡掉的陈旧写也会打出「node X failed」
 * 而节点其实是 succeeded。报出从未发生的状态转移比不报更坏。
 */
export async function updateNodeStatus(
  db: Db,
  nodeId: string,
  input: { status: NodeStatus; detail?: string | null; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const terminal = isTerminalNodeStatus(input.status);
  // 终态不可回退守卫：**任何**转移（转终态 or 转 running）的 WHERE 都排除已终态节点，
  // 堵住 loadNodes→update 的 TOCTOU。
  //  · 终态→终态：陈旧调用不能把已 succeeded 的节点改判 failed。
  //  · 终态→非终态（本轮补齐）：陈旧的 pollInflightNode 若在并发 tick 已把节点标 succeeded
  //    之后才观测到 boss 'active' 并写 running，会**复活**终态节点、抹掉 finished_at，使
  //    summarize 的 terminal 计数永远凑不齐 → run 卡 running 无限自转 tick。故守卫对两类
  //    转移一视同仁。
  const guard = and(
    eq(dag_orchestration_node.id, nodeId),
    notInArray(dag_orchestration_node.status, [...TERMINAL_NODE_STATUSES]),
  );
  const rows = await db
    .update(dag_orchestration_node)
    .set({
      status: input.status,
      // detail 只在显式给出时写（skip/fail 留因）；running 中间态不覆盖既有 detail。
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(terminal ? { finished_at: now } : {}),
      updated_at: now,
    })
    .where(guard)
    .returning({ id: dag_orchestration_node.id });
  return rows.length > 0;
}

function toRunRow(r: typeof dag_orchestration_run.$inferSelect): RunRow {
  return {
    id: r.id,
    run_date: r.run_date,
    trigger: r.trigger as RunTrigger,
    status: r.status as RunStatus,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

function toNodeRow(r: typeof dag_orchestration_node.$inferSelect): NodeRow {
  return {
    id: r.id,
    run_id: r.run_id,
    job_name: r.job_name,
    status: r.status as NodeStatus,
    boss_job_id: r.boss_job_id,
    stale: r.stale,
    detail: r.detail,
    enqueued_at: r.enqueued_at,
    finished_at: r.finished_at,
  };
}
