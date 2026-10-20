// Nightly DAG orchestrator. The anchor creates the run and roots; ticks poll,
// advance ready nodes and self-schedule until settled. Hard downstreams skip after
// failed/skipped upstreams; soft edges run anyway and record stale on the node row.
// Handlers get no stale signal; not_needed/degraded are soft terminals.

import { randomUUID } from 'node:crypto';

import type { Db } from '@/db/client';
import type { JobDag } from '@/kernel/job-dag';
import { readJobYieldReport } from '@/server/boss/job-yield';
import {
  LAYER_STAGGER_MAX_SECONDS,
  LAYER_STAGGER_SECONDS,
  NODE_TIMEOUT_SECONDS,
  ORCHESTRATOR_ANCHOR_HOUR,
  ORCHESTRATOR_ANCHOR_MINUTE,
  ORCHESTRATOR_CATCHUP_WINDOW_SECONDS,
  ORCHESTRATOR_QUEUE,
  ORCHESTRATOR_TZ,
  TICK_INTERVAL_SECONDS,
} from './constants';
import {
  type NightlyContext,
  loadNightlyContext,
  noteEligibilitySkip,
  warnDailyCostDoesNotBlock,
} from './nightly-signals';
import {
  type NodeRow,
  type RunRow,
  type RunTrigger,
  claimNodeNotNeeded,
  claimNodePending,
  createRunWithNodes,
  finishRun,
  getActiveRunById,
  getActiveRunForDate,
  getLatestRunForDate,
  insertNodes,
  isTerminalNodeStatus,
  listActiveRuns,
  loadNode,
  loadNodes,
  updateNodeStatus,
} from './store';

/** Narrow interface so DB tests can inject a fake boss. */
export interface OrchestratorBoss {
  /** Persist this id with the claim before send; re-sending is idempotent. */
  send(
    name: string,
    data: object,
    options?: { startAfter?: number; id?: string },
  ): Promise<string | null>;
  /** The handler's resolved value, carrying the yield report. */
  getJobById(name: string, id: string): Promise<{ state: string; output?: unknown } | null>;
  /** Cancels created/retry/active; an active handler still finishes and writes. */
  cancel(name: string, id: string): Promise<void>;
}

export interface AdvanceDeps {
  db: Db;
  boss: OrchestratorBoss;
  dag: JobDag;
  run: RunRow;
  now?: Date;
  /** Test-only override. */
  timeoutSeconds?: number;
}

export interface AdvanceSummary {
  total: number;
  terminal: number;
  succeeded: number;
  notNeeded: number;
  degraded: number;
  failed: number;
  skipped: number;
  enqueued: number;
  running: number;
  pending: number;
  /** Not "ran on stale input": it only says the node was enqueued anyway. */
  stale: number;
  complete: boolean;
}

/** pg-boss state -> node state. `expired` covers a downgrade cheaply. */
export function mapBossState(
  state: string | null,
): 'succeeded' | 'failed' | 'running' | 'enqueued' | null {
  switch (state) {
    case 'completed':
      return 'succeeded';
    case 'failed':
    case 'cancelled':
    case 'expired':
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
 * Settles and logs one node; the scheduling tables are BACKUP_EXCLUDED, so this is
 * the diagnostic choke point. Logs only on a real CAS change. failed -> error,
 * skipped -> warn, succeeded -> silent.
 */
async function settleNode(
  db: Db,
  run: RunRow,
  node: NodeRow,
  input: {
    status: 'succeeded' | 'failed' | 'skipped' | 'not_needed' | 'degraded';
    detail?: string | null;
    now: Date;
  },
): Promise<boolean> {
  const applied = await updateNodeStatus(db, node.id, input);
  if (!applied) return false;
  node.status = input.status;
  if (input.status === 'succeeded') return true;
  const line = `[orchestrator] node '${node.job_name}' ${input.status} in run ${run.id} (${run.run_date})${
    input.detail ? `: ${input.detail}` : ''
  }`;
  if (input.status === 'failed' || input.status === 'degraded') console.error(line);
  else console.warn(line);
  return true;
}

/** "enqueued despite", not "ran with": failed sends and aborted staggered jobs never ran. */
function describeNodeCensus(s: AdvanceSummary): string {
  return `${s.succeeded}/${s.total} succeeded, ${s.notNeeded} not_needed, ${s.degraded} degraded, ${
    s.failed
  } failed, ${s.skipped} skipped, ${s.enqueued + s.running} still in flight, ${
    s.pending
  } never started, ${s.stale} enqueued despite an upstream that did not succeed`;
}

/** Advances one step: poll in-flight, then advance ready pending nodes. Idempotent. */
export async function advanceRun(deps: AdvanceDeps): Promise<AdvanceSummary> {
  const now = deps.now ?? new Date();
  const timeoutMs = (deps.timeoutSeconds ?? NODE_TIMEOUT_SECONDS) * 1000;

  // Poll in parallel, isolating each node: one failure must not redeliver the pass.
  const inflight = await loadNodes(deps.db, deps.run.id);
  await Promise.all(
    [...inflight.values()].map(async (node) => {
      try {
        await pollInflightNode(deps, node, now, timeoutMs);
      } catch (err) {
        console.error(
          `[orchestrator] poll failed for node '${node.job_name}' (${node.id}) in run ${deps.run.id} — skipped this tick, will retry next tick`,
          err,
        );
      }
    }),
  );

  // Step 2: evaluate pending nodes. Each job has its own worker; see stagger.
  const nodes = await loadNodes(deps.db, deps.run.id);
  let enqueuedThisPass = 0;
  let contextPromise: Promise<NightlyContext> | undefined;
  const loadContext = () => {
    contextPromise ??= loadNightlyContext(deps.db, now, [...deps.dag.nodes.keys()]);
    return contextPromise;
  };
  for (const [jobName, node] of nodes) {
    if (node.status !== 'pending') continue;
    // Per-node isolation: one failure must not stop the other ready nodes this pass.
    try {
      if (
        await advancePendingNode(deps, jobName, node, nodes, now, enqueuedThisPass, loadContext)
      ) {
        enqueuedThisPass += 1;
      }
    } catch (err) {
      console.error(
        `[orchestrator] enqueue failed for node '${node.job_name}' (${node.id}) in run ${deps.run.id} — skipped this tick, will retry next tick`,
        err,
      );
    }
  }

  return summarize(nodes);
}

/** True only when a job was really enqueued; skip/wait/lost-claim return false. */
async function advancePendingNode(
  deps: AdvanceDeps,
  jobName: string,
  node: NodeRow,
  nodes: Map<string, NodeRow>,
  now: Date,
  staggerIndex: number,
  loadContext: () => Promise<NightlyContext>,
): Promise<boolean> {
  {
    const dagNode = deps.dag.nodes.get(jobName);
    if (!dagNode) {
      // Removed/renamed mid-run; skipping would leave total > terminal forever.
      await settleNode(deps.db, deps.run, node, {
        status: 'skipped',
        detail: 'job is no longer a DAG member in the running build (manifest changed mid-run)',
        now,
      });
      return false;
    }

    const upstreams = dagNode.deps.map((d) => ({ soft: d.soft, job: d.job, up: nodes.get(d.job) }));

    // A missing hard row would hang this node forever.
    const missingHard = upstreams.find((u) => !u.soft && !u.up);
    if (missingHard) {
      await settleNode(deps.db, deps.run, node, {
        status: 'skipped',
        detail: `upstream '${missingHard.job}' has no node row in this run`,
        now,
      });
      return false;
    }

    // Hard upstream failed/skipped.
    const blocked = upstreams.find(
      (u) => !u.soft && u.up && (u.up.status === 'failed' || u.up.status === 'skipped'),
    );
    if (blocked?.up) {
      await settleNode(deps.db, deps.run, node, {
        status: 'skipped',
        detail: `upstream '${blocked.up.job_name}' ${blocked.up.status}`,
        now,
      });
      return false;
    }

    // Missing soft rows count as terminal-but-not-succeeded; roots enqueue at once.
    const allTerminal = upstreams.every((u) => (u.up ? isTerminalNodeStatus(u.up.status) : u.soft));
    if (!allTerminal) return false;

    if (dagNode.eligibility) {
      const decision = dagNode.eligibility((await loadContext()).forJob(jobName));
      if (!decision.run) {
        noteEligibilitySkip(jobName, decision);
        const applied = await claimNodeNotNeeded(deps.db, node.id, {
          detail: decision.reason,
          now,
        });
        if (!applied) {
          const fresh = await loadNode(deps.db, node.id);
          if (fresh) Object.assign(node, fresh);
          return false;
        }
        node.status = 'not_needed';
        node.detail = decision.reason;
        node.finished_at = now;
        console.warn(
          `[orchestrator] node '${node.job_name}' not_needed in run ${deps.run.id} (${deps.run.run_date}): ${decision.reason}`,
        );
        return false;
      }
    }

    // Any non-succeeded upstream makes the node stale; the fact stays on the row.
    const stale = upstreams.some((u) => u.up?.status !== 'succeeded');

    // Only the CAS winner sends; the id is persisted before send.
    const bossJobId = randomUUID();
    const claimed = await claimNodePending(deps.db, node.id, { bossJobId, stale, now });
    if (!claimed) return false;
    // Sync the row so this pass's census counts it; a send failure can complete the pass.
    node.stale = stale;

    // Serial chains get offset 0; the payload stays empty.
    const startAfter = Math.min(staggerIndex * LAYER_STAGGER_SECONDS, LAYER_STAGGER_MAX_SECONDS);
    const sentId = await deps.boss.send(
      jobName,
      {},
      startAfter > 0 ? { id: bossJobId, startAfter } : { id: bossJobId },
    );
    if (!sentId) {
      // null = ON CONFLICT: the id already exists.
      const existing = await deps.boss.getJobById(jobName, bossJobId);
      if (!existing) {
        // Not created.
        await settleNode(deps.db, deps.run, node, {
          status: 'failed',
          detail: 'boss.send returned null and no job exists for the reserved id',
          now,
        });
        return false;
      }
    }
    node.status = 'enqueued';
    return true;
  }
}

/** Polls one in-flight node (step 1). */
async function pollInflightNode(
  deps: AdvanceDeps,
  node: NodeRow,
  now: Date,
  timeoutMs: number,
): Promise<void> {
  if (node.status !== 'enqueued' && node.status !== 'running') return;
  const job = node.boss_job_id ? await deps.boss.getJobById(node.job_name, node.boss_job_id) : null;
  const jobState = mapBossState(job?.state ?? null);
  if (jobState === 'succeeded') {
    // A stalled yield becomes degraded; degraded stays succeeded with detail.
    const report = readJobYieldReport(job?.output);
    await settleNode(deps.db, deps.run, node, {
      status: report?.level === 'stalled' ? 'degraded' : 'succeeded',
      detail: report?.detail ?? undefined,
      now,
    });
  } else if (jobState === 'failed') {
    await settleNode(deps.db, deps.run, node, {
      status: 'failed',
      detail: 'pg-boss job failed',
      now,
    });
  } else if (jobState === 'running' && node.status !== 'running') {
    await updateNodeStatus(deps.db, node.id, { status: 'running', now });
  } else if (jobState === null || jobState === 'enqueued') {
    // No row: re-send the reserved id until the node times out. A shorter window would
    // fail a job that never existed after a slow restart; retention far exceeds it.
    if (jobState === null && node.boss_job_id && !isNodeTimedOut(node, now, timeoutMs)) {
      console.warn(
        `[orchestrator] node '${node.job_name}' (${node.id}) has no pg-boss job for reserved id ${node.boss_job_id} — re-sending idempotently (send never landed)`,
      );
      // Same empty payload as the first send.
      await deps.boss.send(node.job_name, {}, { id: node.boss_job_id });
      return;
    }
    if (isNodeTimedOut(node, now, timeoutMs)) {
      // Cancel first: the job could still run and write while the graph says it did not.
      if (jobState !== null && node.boss_job_id) {
        await cancelBossJob(
          deps.boss,
          node.job_name,
          node.boss_job_id,
          `node timed out in run ${deps.run.id}`,
        );
      }
      await settleNode(deps.db, deps.run, node, {
        status: 'failed',
        detail: jobState === null ? 'pg-boss job not found (timeout)' : 'timeout',
        now,
      });
    }
  }
}

/** Best-effort cancel: failure logs, never throws, so it cannot block timeout/abandon. */
async function cancelBossJob(
  boss: OrchestratorBoss,
  jobName: string,
  bossJobId: string,
  context: string,
): Promise<boolean> {
  try {
    await boss.cancel(jobName, bossJobId);
    return true;
  } catch (err) {
    console.error(
      `[orchestrator] failed to cancel pg-boss job ${bossJobId} for member '${jobName}' (${context}) — it may still execute and write data`,
      err,
    );
    return false;
  }
}

/**
 * Cancels in-flight jobs when a run is abandoned (after finishRun; ordering there).
 * Without it old jobs write data, the new run re-enqueues the same paid members, and
 * they bypass the new dependency gate. Dispatched rows become failed; never-enqueued
 * rows become skipped. Never throws, so a loadNodes failure cannot skip tonight.
 */
async function cancelRunInflightJobs(
  deps: { db: Db; boss: OrchestratorBoss },
  run: RunRow,
  now: Date,
  /** Only gates the census log. */
  announce: boolean,
): Promise<void> {
  let nodes: Map<string, NodeRow>;
  try {
    nodes = await loadNodes(deps.db, run.id);
  } catch (err) {
    console.error(
      `[orchestrator] failed to load nodes of run ${run.id} (${run.run_date}) while abandoning — its in-flight jobs are NOT cancelled and may still execute; abandoning anyway so tonight can start`,
      err,
    );
    return;
  }
  // Snapshot before the sweep rewrites the rows.
  if (announce) {
    console.error(
      `[orchestrator] abandoned run ${run.id} (${run.run_date}) left ${describeNodeCensus(
        summarize(nodes),
      )} — settling its non-terminal nodes and cancelling their pg-boss jobs`,
    );
  }
  for (const node of nodes.values()) {
    if (isTerminalNodeStatus(node.status)) continue;
    try {
      if (!node.boss_job_id) {
        await settleNode(deps.db, run, node, {
          status: 'skipped',
          detail: 'run abandoned before this node was enqueued',
          now,
        });
        continue;
      }
      const cancelled = await cancelBossJob(
        deps.boss,
        node.job_name,
        node.boss_job_id,
        `run ${run.id} (${run.run_date}) abandoned`,
      );
      await settleNode(deps.db, run, node, {
        status: 'failed',
        detail: cancelled
          ? 'run abandoned; pg-boss job cancelled'
          : 'run abandoned; pg-boss job cancel failed (job may still execute)',
        now,
      });
    } catch (err) {
      console.error(
        `[orchestrator] failed to settle node '${node.job_name}' (${node.id}) while abandoning run ${run.id}`,
        err,
      );
    }
  }
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
    notNeeded: 0,
    degraded: 0,
    failed: 0,
    skipped: 0,
    enqueued: 0,
    running: 0,
    pending: 0,
    stale: 0,
    complete: false,
  };
  for (const node of nodes.values()) {
    s.total += 1;
    if (node.stale) s.stale += 1;
    switch (node.status) {
      case 'succeeded':
        s.succeeded += 1;
        s.terminal += 1;
        break;
      case 'not_needed':
        s.notNeeded += 1;
        s.terminal += 1;
        break;
      case 'degraded':
        s.degraded += 1;
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
  /** DI seam for tests. */
  localDate?: (now: Date) => string;
}

/** Local date (YYYY-MM-DD, Asia/Shanghai by default), matching the practice read path. */
export function orchestratorLocalDate(now: Date, timeZone = 'Asia/Shanghai'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Anchor: close stale runs, find/create tonight's run, advance, schedule tick. */
export async function runOrchestratorStart(
  deps: DriveDeps,
  trigger: RunTrigger,
): Promise<RunRow | null> {
  const now = deps.now ?? new Date();
  const runDate = (deps.localDate ?? orchestratorLocalDate)(now);

  // Close stale runs and cancel their jobs. finishRun first, or a queued tick can send
  // jobs after the cancel snapshot; one claim->send can still leak.
  for (const leftover of await listActiveRuns(deps.db)) {
    if (leftover.run_date !== runDate) {
      // Log only when the CAS won.
      const abandoned = await finishRun(deps.db, leftover.id, 'abandoned', now);
      if (abandoned) {
        console.error(
          `[orchestrator] ABANDONING run ${leftover.id} (${leftover.run_date}) — it was still 'running' when the ${runDate} anchor fired, i.e. that night never reached a terminal state`,
        );
      }
      // Sweep unconditionally; the census follows the CAS result.
      await cancelRunInflightJobs(deps, leftover, now, abandoned);
    }
  }

  let run = await getActiveRunForDate(deps.db, runDate);
  if (!run) {
    // No rerun for a day that already has any run; manual may rerun after completion.
    const guarded = trigger === 'cron' ? await getLatestRunForDate(deps.db, runDate) : null;
    if (guarded) {
      // Warn: a leftover row (e.g. archive restore) must be distinguishable from a run.
      console.warn(
        `[orchestrator] cron anchor for ${runDate} did NOT start a chain: run ${guarded.id} already exists for this date (${guarded.status}). This is the redeliver guard; if you did not expect a run today, check for a leftover row (e.g. an archive restore) — the guard cannot tell one from a genuine earlier start`,
      );
      return null;
    }
    run = await createRunWithNodes(deps.db, {
      runDate,
      trigger,
      jobNames: [...deps.dag.nodes.keys()],
      now,
    });
    if (run) {
      // Only evidence that the anchor actually opened tonight.
      console.log(
        `[orchestrator] run ${run.id} started for ${runDate} (trigger=${trigger}, ${deps.dag.nodes.size} member(s), ${deps.dag.roots.length} root(s))`,
      );
      await warnDailyCostDoesNotBlock(deps.db, now);
    } else {
      run = await getActiveRunForDate(deps.db, runDate);
    }
  }
  if (!run) return null;

  // Idempotent self-heal; a zero-node run would spin forever.
  await insertNodes(deps.db, run.id, [...deps.dag.nodes.keys()], now);

  await advanceAndContinue({ ...deps, now, run });
  return run;
}

/** Tick: advance, close if complete, otherwise schedule the next tick. */
export async function runOrchestratorTick(deps: DriveDeps, runId?: string): Promise<void> {
  const now = deps.now ?? new Date();
  // Prefer the run id; a date lookup loses a run that crossed midnight.
  const run = runId
    ? await getActiveRunById(deps.db, runId)
    : await getActiveRunForDate(deps.db, (deps.localDate ?? orchestratorLocalDate)(now));
  if (!run) return;

  // Self-heal members added mid-run; idempotent, so they join tonight.
  await insertNodes(deps.db, run.id, [...deps.dag.nodes.keys()], now);

  await advanceAndContinue({ ...deps, now, run });
}

/** Local minute of day. */
export function orchestratorLocalMinuteOfDay(now: Date, timeZone = ORCHESTRATOR_TZ): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: 'hour' | 'minute') =>
    Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  return value('hour') * 60 + value('minute');
}

export const MINUTES_PER_DAY = 24 * 60;

/**
 * Minutes since the last anchor, mod 1440. A bare subtraction breaks for a late
 * anchor; the wrap still rejects a time before an early anchor.
 */
export function minutesSinceAnchor(
  now: Date,
  anchorMinuteOfDay = ORCHESTRATOR_ANCHOR_HOUR * 60 + ORCHESTRATOR_ANCHOR_MINUTE,
  timeZone = ORCHESTRATOR_TZ,
): number {
  return (
    (orchestratorLocalMinuteOfDay(now, timeZone) - anchorMinuteOfDay + MINUTES_PER_DAY) %
    MINUTES_PER_DAY
  );
}

/**
 * Catch-up gate. Fails closed: NaN or a window >= 1440 would pass every moment.
 */
export function isWithinCatchUpWindow(elapsedMinutes: number, windowMinutes: number): boolean {
  if (!Number.isFinite(elapsedMinutes)) {
    throw new Error(
      `[orchestrator] cannot evaluate the catch-up window: minutes-since-anchor is ${elapsedMinutes} (unreadable local clock)`,
    );
  }
  if (!(windowMinutes > 0 && windowMinutes < MINUTES_PER_DAY)) {
    throw new Error(
      `[orchestrator] cannot evaluate the catch-up window: ORCHESTRATOR_CATCHUP_WINDOW_SECONDS yields ${windowMinutes}min, which must be >0 and <${MINUTES_PER_DAY} (a whole-day window makes "before" and "after" the anchor indistinguishable)`,
    );
  }
  return elapsedMinutes < windowMinutes;
}

/** Catch-up decision, exposed for tests. */
export type CatchUpOutcome =
  | { action: 'started'; run: RunRow }
  | { action: 'skipped'; reason: 'outside-window' | 'run-exists' | 'error' };

/**
 * Idempotent boot catch-up. Window: inside [anchor, anchor + window), or a restart
 * drags the paid chain into learner hours. No run today: any status, so a completed
 * run does not rerun and a running one is not adopted beside its tick.
 *
 * Never throws; concurrent boots rely on run single-flight and per-node claims.
 */
export async function runOrchestratorCatchUp(deps: DriveDeps): Promise<CatchUpOutcome> {
  try {
    const now = deps.now ?? new Date();
    const elapsed = minutesSinceAnchor(now);
    const windowMinutes = ORCHESTRATOR_CATCHUP_WINDOW_SECONDS / 60;
    if (!isWithinCatchUpWindow(elapsed, windowMinutes)) {
      console.log(
        `[orchestrator] boot catch-up skipped: ${elapsed}min since the last ${ORCHESTRATOR_ANCHOR_HOUR}:${String(ORCHESTRATOR_ANCHOR_MINUTE).padStart(2, '0')} ${ORCHESTRATOR_TZ} anchor, outside the ${windowMinutes}min window`,
      );
      return { action: 'skipped', reason: 'outside-window' };
    }
    const runDate = (deps.localDate ?? orchestratorLocalDate)(now);
    const existing = await getLatestRunForDate(deps.db, runDate);
    if (existing) {
      console.log(
        `[orchestrator] boot catch-up skipped: run ${existing.id} already exists for ${runDate} (${existing.status})`,
      );
      return { action: 'skipped', reason: 'run-exists' };
    }
    console.warn(
      `[orchestrator] boot catch-up: no run for ${runDate} and we are ${elapsed}min past the anchor — the anchor cron was missed (pg-boss does not replay missed crons); starting tonight's run now`,
    );
    const run = await runOrchestratorStart(deps, 'cron');
    // null: a concurrent replica won the start guard, not a failure.
    return run ? { action: 'started', run } : { action: 'skipped', reason: 'run-exists' };
  } catch (err) {
    // The run may sit running with no tick; the next anchor abandons and cancels it.
    console.error(
      '[orchestrator] boot catch-up failed (non-fatal, waiting for the next anchor; a run created just before the failure may sit `running` with no tick armed)',
      err,
    );
    return { action: 'skipped', reason: 'error' };
  }
}

/** Advance once, then close or arm the next tick. Normal return iff settled or the
 *  tick is queued; a failed tick send rethrows so pg-boss redelivers an unarmed chain. */
async function advanceAndContinue(
  deps: DriveDeps & { run: RunRow },
): Promise<AdvanceSummary | null> {
  // One now for advance and finish.
  const now = deps.now ?? new Date();
  let summary: AdvanceSummary | null = null;
  let settled = false;
  let advanceError: unknown = null;
  try {
    summary = await advanceRun({
      db: deps.db,
      boss: deps.boss,
      dag: deps.dag,
      run: deps.run,
      now,
      timeoutSeconds: deps.timeoutSeconds,
    });
    if (summary.complete) {
      if (await finishRun(deps.db, deps.run.id, 'completed', now)) {
        console.log(
          `[orchestrator] run ${deps.run.id} (${deps.run.run_date}) completed: ${describeNodeCensus(summary)}`,
        );
      }
      settled = true;
    }
  } catch (err) {
    advanceError = err;
  }

  if (!settled) {
    // Outside the try: failure must reach pg-boss. The id locates the run across midnight.
    const tickId = await deps.boss.send(
      ORCHESTRATOR_QUEUE,
      { tick: true, runId: deps.run.id },
      { startAfter: TICK_INTERVAL_SECONDS },
    );
    if (!tickId) {
      // null: not armed.
      throw new Error(
        `[orchestrator] next tick send returned null for run ${deps.run.id} (${deps.run.run_date}) — tick chain not armed`,
      );
    }
  }

  // Armed: swallowing is safe. This failure will not reach the DLQ; the log remains.
  if (advanceError) {
    console.error(
      `[orchestrator] advance failed for run ${deps.run.id} (${deps.run.run_date}) — the next tick IS queued, so the chain survives; state is re-read from DB next tick`,
      advanceError,
    );
  }
  return summary;
}
