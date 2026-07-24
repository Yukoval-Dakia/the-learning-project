// YUK-758 — orchestrator 调度态存取（dag_orchestration_run / _node）。
//
// 控制面调度记录，物理隔离于 event 数据面（立票红线）。所有写显式落每个非平凡列
// （audit:schema write-path 契约）。

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { dag_orchestration_node, dag_orchestration_run } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

export type RunTrigger = 'cron' | 'manual';
export type RunStatus = 'running' | 'completed' | 'abandoned';
export type NodeStatus = 'pending' | 'enqueued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set<NodeStatus>([
  'succeeded',
  'failed',
  'skipped',
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
  db: Db,
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

/** 今日的 active（running）run，若无返回 null。 */
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

export async function finishRun(
  db: Db,
  runId: string,
  status: 'completed' | 'abandoned',
  now = new Date(),
): Promise<void> {
  await db
    .update(dag_orchestration_run)
    .set({ status, finished_at: now, updated_at: now })
    .where(eq(dag_orchestration_run.id, runId));
}

/** 批量落节点行（全 pending）。job 名唯一性由 unique(run_id, job_name) 兜。 */
export async function insertNodes(
  db: Db,
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

/** 载入某 run 全部节点，映射 job_name → 行。 */
export async function loadNodes(db: Db, runId: string): Promise<Map<string, NodeRow>> {
  const rows = await db
    .select()
    .from(dag_orchestration_node)
    .where(eq(dag_orchestration_node.run_id, runId));
  const map = new Map<string, NodeRow>();
  for (const r of rows) map.set(r.job_name, toNodeRow(r));
  return map;
}

/** 记节点已入队（boss.send 后）。 */
export async function markNodeEnqueued(
  db: Db,
  nodeId: string,
  input: { bossJobId: string | null; stale: boolean; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(dag_orchestration_node)
    .set({
      status: 'enqueued',
      boss_job_id: input.bossJobId,
      stale: input.stale,
      enqueued_at: now,
      updated_at: now,
    })
    .where(eq(dag_orchestration_node.id, nodeId));
}

/** 更新节点状态（running 中间态 / 终态 succeeded|failed|skipped + detail）。 */
export async function updateNodeStatus(
  db: Db,
  nodeId: string,
  input: { status: NodeStatus; detail?: string | null; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const terminal = isTerminalNodeStatus(input.status);
  await db
    .update(dag_orchestration_node)
    .set({
      status: input.status,
      // detail 只在显式给出时写（skip/fail 留因）；running 中间态不覆盖既有 detail。
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(terminal ? { finished_at: now } : {}),
      updated_at: now,
    })
    .where(eq(dag_orchestration_node.id, nodeId));
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
