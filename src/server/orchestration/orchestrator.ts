// YUK-758 — 夜间任务编排 orchestrator 驱动核心。
//
// 单锚点 cron 开闸 → 建「今晚运行记录」+ enqueue 根节点；每 tick 轮询节点终态、推进
// 就绪下游、跳过硬上游失败者，未完成则自调度下一 tick。执行仍走既有 pg-boss handler
// （orchestrator 只 boss.send 触发 + 轮询 boss.getJobById），业务代码零改动。
//
// 逐边失败语义：硬边（默认）——上游 failed/skipped → 下游 skipped（留 detail 痕迹）；
// 软边——上游未 succeeded 但硬上游齐 → 下游照跑，job payload 带 { stale: true }。

import type { Db } from '@/db/client';
import type { JobDag } from '@/kernel/job-dag';
import { NODE_TIMEOUT_SECONDS, ORCHESTRATOR_QUEUE, TICK_INTERVAL_SECONDS } from './constants';
import {
  type NodeRow,
  type RunRow,
  type RunTrigger,
  createRun,
  finishRun,
  getActiveRunForDate,
  insertNodes,
  isTerminalNodeStatus,
  listActiveRuns,
  loadNodes,
  markNodeEnqueued,
  updateNodeStatus,
} from './store';

/** orchestrator 只需 pg-boss 的这两个能力——窄接口让 DB 测试注入 fake boss。 */
export interface OrchestratorBoss {
  send(name: string, data: object, options?: { startAfter?: number }): Promise<string | null>;
  getJobById(name: string, id: string): Promise<{ state: string } | null>;
}

export interface AdvanceDeps {
  db: Db;
  boss: OrchestratorBoss;
  dag: JobDag;
  run: RunRow;
  now?: Date;
  /** 覆盖节点超时（测试注入小值）。 */
  timeoutSeconds?: number;
}

export interface AdvanceSummary {
  total: number;
  terminal: number;
  succeeded: number;
  failed: number;
  skipped: number;
  enqueued: number;
  running: number;
  pending: number;
  /** 全部成员节点终态 → run 可收尾。 */
  complete: boolean;
}

/** pg-boss job state → 节点态映射。null = 查不到 job 行（消失/未知）。 */
export function mapBossState(
  state: string | null,
): 'succeeded' | 'failed' | 'running' | 'enqueued' | null {
  switch (state) {
    case 'completed':
      return 'succeeded';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'active':
      return 'running';
    case 'created':
    case 'retry':
      return 'enqueued';
    default:
      return null;
  }
}

/**
 * 推进一条 run 一步：①轮询在飞节点终态 ②推进就绪 pending 节点（enqueue / 硬失败跳过）。
 * 幂等：只对 pending 节点做 enqueue、只对在飞节点做轮询——重复 tick 收敛到同一态。
 */
export async function advanceRun(deps: AdvanceDeps): Promise<AdvanceSummary> {
  const now = deps.now ?? new Date();
  const timeoutMs = (deps.timeoutSeconds ?? NODE_TIMEOUT_SECONDS) * 1000;

  // ── ① 轮询在飞（enqueued/running）节点的 pg-boss 终态。
  const inflight = await loadNodes(deps.db, deps.run.id);
  for (const node of inflight.values()) {
    if (node.status !== 'enqueued' && node.status !== 'running') continue;
    const jobState = node.boss_job_id
      ? mapBossState((await deps.boss.getJobById(node.job_name, node.boss_job_id))?.state ?? null)
      : null;
    if (jobState === 'succeeded') {
      await updateNodeStatus(deps.db, node.id, { status: 'succeeded', now });
    } else if (jobState === 'failed') {
      await updateNodeStatus(deps.db, node.id, {
        status: 'failed',
        detail: 'pg-boss job failed',
        now,
      });
    } else if (jobState === 'running' && node.status !== 'running') {
      await updateNodeStatus(deps.db, node.id, { status: 'running', now });
    } else if (jobState === null || jobState === 'enqueued') {
      // 仍在飞（created/retry/active-not-yet）或 job 行查不到 → 超时兜底。
      if (isNodeTimedOut(node, now, timeoutMs)) {
        await updateNodeStatus(deps.db, node.id, {
          status: 'failed',
          detail: jobState === null ? 'pg-boss job not found (timeout)' : 'timeout',
          now,
        });
      }
    }
  }

  // ── ② 用最新态评估 pending 节点是否就绪。
  const nodes = await loadNodes(deps.db, deps.run.id);
  for (const [jobName, node] of nodes) {
    if (node.status !== 'pending') continue;
    const dagNode = deps.dag.nodes.get(jobName);
    if (!dagNode) continue; // 成员集与图不一致（不应发生）——跳过防御。

    const upstreams = dagNode.deps.map((d) => ({ soft: d.soft, up: nodes.get(d.job) }));

    // 硬上游 failed/skipped → 本节点跳过（留因）。
    const blocked = upstreams.find(
      (u) => !u.soft && u.up && (u.up.status === 'failed' || u.up.status === 'skipped'),
    );
    if (blocked?.up) {
      await updateNodeStatus(deps.db, node.id, {
        status: 'skipped',
        detail: `upstream '${blocked.up.job_name}' ${blocked.up.status}`,
        now,
      });
      node.status = 'skipped';
      continue;
    }

    // 全部上游终态才可推进（否则等待）。根（无上游）此处 vacuous-true 即刻入队。
    const allTerminal = upstreams.every((u) => u.up && isTerminalNodeStatus(u.up.status));
    if (!allTerminal) continue;

    // 到此硬上游必全 succeeded（否则被 blocked 拦）。软上游若未 succeeded → stale。
    const stale = upstreams.some((u) => u.soft && u.up && u.up.status !== 'succeeded');
    const jobId = await deps.boss.send(jobName, stale ? { stale: true } : {});
    await markNodeEnqueued(deps.db, node.id, { bossJobId: jobId, stale, now });
    node.status = 'enqueued';
  }

  // ── ③ 汇总（用②后 in-memory map；enqueue/skip 已就地更新 status）。
  return summarize(nodes);
}

function isNodeTimedOut(node: NodeRow, now: Date, timeoutMs: number): boolean {
  if (!node.enqueued_at) return false;
  return now.getTime() - node.enqueued_at.getTime() > timeoutMs;
}

function summarize(nodes: Map<string, NodeRow>): AdvanceSummary {
  const s: AdvanceSummary = {
    total: 0,
    terminal: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    enqueued: 0,
    running: 0,
    pending: 0,
    complete: false,
  };
  for (const node of nodes.values()) {
    s.total += 1;
    switch (node.status) {
      case 'succeeded':
        s.succeeded += 1;
        s.terminal += 1;
        break;
      case 'failed':
        s.failed += 1;
        s.terminal += 1;
        break;
      case 'skipped':
        s.skipped += 1;
        s.terminal += 1;
        break;
      case 'enqueued':
        s.enqueued += 1;
        break;
      case 'running':
        s.running += 1;
        break;
      case 'pending':
        s.pending += 1;
        break;
    }
  }
  s.complete = s.total > 0 && s.terminal === s.total;
  return s;
}

export interface DriveDeps {
  db: Db;
  boss: OrchestratorBoss;
  dag: JobDag;
  now?: Date;
  timeoutSeconds?: number;
  /** DI seam：解析「今天」本地日（默认 Asia/Shanghai）。测试注入固定日。 */
  localDate?: (now: Date) => string;
}

/** 本地日（YYYY-MM-DD，默认 Asia/Shanghai）——与练习流读路径一致的时区口径。 */
export function orchestratorLocalDate(now: Date, timeZone = 'Asia/Shanghai'): string {
  // en-CA → YYYY-MM-DD。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * 锚点开闸（cron 或 manual）：收尾过期残留 run → find-or-create 今晚 run → 落节点 →
 * 推进一步 → 未完成则调度首个 tick。
 */
export async function runOrchestratorStart(
  deps: DriveDeps,
  trigger: RunTrigger,
): Promise<RunRow | null> {
  const now = deps.now ?? new Date();
  const runDate = (deps.localDate ?? orchestratorLocalDate)(now);

  // 收尾**跨日**残留 running run（上一夜 worker 挂掉遗留）——今日的不动。
  for (const stale of await listActiveRuns(deps.db)) {
    if (stale.run_date !== runDate) {
      await finishRun(deps.db, stale.id, 'abandoned', now);
    }
  }

  let run = await getActiveRunForDate(deps.db, runDate);
  if (!run) {
    run = await createRun(deps.db, { runDate, trigger, now });
    if (run) {
      await insertNodes(deps.db, run.id, [...deps.dag.nodes.keys()], now);
    } else {
      // 撞单飞（并发 start）——采纳赢家的 run。
      run = await getActiveRunForDate(deps.db, runDate);
    }
  }
  if (!run) return null;

  await advanceAndContinue({ ...deps, now, run });
  return run;
}

/**
 * tick：推进今晚 active run 一步，未完成则自调度下一 tick，完成则收尾。无 active run →
 * no-op（run 已终结或尚未起步）。
 */
export async function runOrchestratorTick(deps: DriveDeps): Promise<void> {
  const now = deps.now ?? new Date();
  const runDate = (deps.localDate ?? orchestratorLocalDate)(now);
  const run = await getActiveRunForDate(deps.db, runDate);
  if (!run) return;
  await advanceAndContinue({ ...deps, now, run });
}

/** 推进一步 → 完成收尾 / 未完成调度下一 tick。 */
async function advanceAndContinue(deps: DriveDeps & { run: RunRow }): Promise<AdvanceSummary> {
  const summary = await advanceRun({
    db: deps.db,
    boss: deps.boss,
    dag: deps.dag,
    run: deps.run,
    now: deps.now,
    timeoutSeconds: deps.timeoutSeconds,
  });
  if (summary.complete) {
    await finishRun(deps.db, deps.run.id, 'completed', deps.now ?? new Date());
  } else {
    await deps.boss.send(ORCHESTRATOR_QUEUE, { tick: true }, { startAfter: TICK_INTERVAL_SECONDS });
  }
  return summary;
}
