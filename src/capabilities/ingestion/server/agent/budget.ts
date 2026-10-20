// YUK-1522 — ingestion-agent 周预算生命周期服务（LIGHT 启动额度门）。
//
// 本服务只回答一个问题：能不能开始一次付费 agent run。判定发生在
// `authorizeAgentRunStart`——它在 dispatch 事务（enqueueAgentRun 的
// beforeTransition hook）内运行，先拿全局 advisory lock 串行所有
// start 判定，然后做四件事：
//   1) 幂等复用——本 operation 已有 in_flight grant → 直接放行（同一启动身份
//      恢复/重放不重复占位、不重复判定）；
//   2) 在途扫描——其它 session 仍有 in_flight grant（在跑/排队/待结算）→ 503；
//      已到终态或 queued 但 job 已消失的旧 grant 惰性 settle 后放行；
//   3) 权威配置——事务内直读 system_config 行 + revision（不依赖 ≤15s 进程
//      快照），DB 无行时按 registry fallback 语义读 env → code default；
//   4) 本周成本——canonical provider-cost 投影按归属规则过滤；USD 已知成本
//      计入 used，unknown/非 USD/无归属依据的相关记录 → 503（不按 0），
//      used >= limit → 429。
// grant 持久在 learning_session.agent_budget（job_events 有 30 天清理，
// 不能当授权身份的唯一真相），与 session 'queued' 翻转 + boss.send 在同一
// 事务提交；事务回滚则授权同时消失，不存在悬空占位。
//
// resume/continue 不经此门：run.ts 用 in_flight grant 取回同一次启动身份
// （resolveAgentRunRef），不新造授权。run 终态统一走 settleAgentRunBudget：
// grant → 'settled'，同时给 operation 投影补终态事件（G6）。unknown 结算
// 不归零：settled grant 只标记生命周期结束，成本真值仍来自 canonical 投影。
//
// 周口径：Asia/Shanghai 自然周一 00:00（含）到下周一 00:00（不含），见
// src/core/learner-day.ts。跨周仍在途的 grant 不因周切换放行另一新 run——
// 在途扫描先看 grant.state，不看 week_start。
//
// 错误契约（ingestion manifest 已登记 429/503）：
//   429 ingestion_weekly_budget_exceeded   used_usd >= limit_usd
//   503 ingestion_weekly_budget_unavailable
//        details.reason ∈ another_ingestion_in_flight | unsettled_cost |
//        budget_read_unavailable
//
// 写面 owner：本文件是 learning_session.agent_budget 的唯一写点。

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { resolveKeyDef } from '@/core/config/registry';
import { learnerLocalWeekWindowUtc } from '@/core/learner-day';
import type { Db, Tx } from '@/db/client';
import { learning_session, system_config } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { providerCostProjectedCte } from '@/kernel/read-models/provider-cost-projection';
import {
  INGESTION_OPERATION_TABLE,
  writeIngestionOperationEvent,
  writeIngestionOperationTerminalOnce,
} from '../operation-store';

// ---------- 常量 ----------

const BUDGET_CONFIG_KEY = 'ingestion.agent_weekly_budget_usd';
/** 全局 start 判定串行锁（与 operation/session 锁次序统一：先本锁，后行锁）。 */
const BUDGET_LOCK_KEY = 'ingestion-agent-weekly-budget';
export const AGENT_BUDGET_WEEK_TZ = 'Asia/Shanghai' as const;

export const AGENT_BUDGET_EXCEEDED_CODE = 'ingestion_weekly_budget_exceeded';
export const AGENT_BUDGET_UNAVAILABLE_CODE = 'ingestion_weekly_budget_unavailable';
const AGENT_BUDGET_EXCEEDED_MESSAGE = '这周录入助手的额度已用完，请下周再试。';

export type AgentBudgetUnavailableReason =
  | 'another_ingestion_in_flight'
  | 'unsettled_cost'
  | 'budget_read_unavailable';

/**
 * learning_session.status 中「agent run 已结束」的全集：extracted|partial|failed
 * 是 run 终态本身；reviewed|imported 只能经 extracted|partial 到达，同样证明
 * run 已结束（其 grant 理应已 settled，残留者属可安全清理的陈旧占位）。
 */
const RUN_OVER_SESSION_STATUSES = new Set([
  'extracted',
  'partial',
  'failed',
  'reviewed',
  'imported',
]);
/**
 * queued session 的 in_flight grant 只在 pg-boss 侧仍有活 job 时才算真在途。
 * 'completed'/'failed'/已被 archive 的行都算无活 job——run 从未开始或已死。
 */
const LIVE_AGENT_JOB_STATES = `('created','retry','active')`;

// GLM OCR 的 provider_attempt anchor 前缀。run.ts 把 toolCtx.taskRunId 定为
// `agentToolRunId(runRef, segment)`（旧代码是随机 ingestion_agent_tool_<cuid>），
// anchor = `glm_ocr:${toolRunId}:${sha256}:${region}`——前缀兼容新旧两形态。
// LIKE 模式：`_` 须转义（ESCAPE '\\'）。
const AGENT_TOOL_RUN_ID_PREFIX = 'ingestion_agent_tool';
const GLM_AGENT_ANCHOR_LIKE = 'glm_ocr:ingestion\\_agent\\_tool%';
const AGENT_TASK_KIND = 'IngestionAgentTask';

// ---------- 持久信封（learning_session.agent_budget jsonb） ----------

const agentBudgetGrantSchema = z.object({
  /** 'in_flight'：授权仍占位（在跑/排队/待结算）；'settled'：生命周期结束。 */
  state: z.enum(['in_flight', 'settled']),
  /** 授权所在周（Asia/Shanghai）起点 UTC 瞬时；收据字段，不参与放行判定。 */
  week_start: z.string(),
  /** 授权瞬时读到的限额与已用额（收据）。 */
  limit_usd: z.number(),
  used_usd_at_grant: z.number(),
  /** 授权瞬时 system_config.revision；env/code-default 层为 null。 */
  config_revision: z.number().int().nullable(),
  granted_at: z.string(),
  settled_at: z.string().optional(),
  /** 终态 settle 原因：run_terminal | session_terminal | queue_vanished。 */
  settle_reason: z.string().optional(),
});
export type AgentBudgetGrant = z.infer<typeof agentBudgetGrantSchema>;

const agentBudgetEnvelopeSchema = z.object({
  week_tz: z.literal(AGENT_BUDGET_WEEK_TZ),
  /** operation_id → grant；同一 session 同一时刻至多一个 in_flight。 */
  grants: z.record(z.string(), agentBudgetGrantSchema),
});
export type AgentBudgetEnvelope = z.infer<typeof agentBudgetEnvelopeSchema>;

/** settled grant 只留最近若干条作回执，防止热 session 无限增长。 */
const MAX_SETTLED_GRANTS = 16;

function parseAgentBudget(raw: unknown): AgentBudgetEnvelope | null {
  if (raw == null) return null;
  const parsed = agentBudgetEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function pruneSettledGrants(envelope: AgentBudgetEnvelope): void {
  const settled = Object.entries(envelope.grants).filter(([, g]) => g.state === 'settled');
  if (settled.length <= MAX_SETTLED_GRANTS) return;
  settled
    .sort((a, b) =>
      (a[1].settled_at ?? a[1].granted_at).localeCompare(b[1].settled_at ?? b[1].granted_at),
    )
    .slice(0, settled.length - MAX_SETTLED_GRANTS)
    .forEach(([opId]) => {
      delete envelope.grants[opId];
    });
}

// ---------- 错误 ----------

function budgetExceeded(): never {
  throw new ApiError(AGENT_BUDGET_EXCEEDED_CODE, AGENT_BUDGET_EXCEEDED_MESSAGE, 429);
}

function budgetUnavailable(
  reason: AgentBudgetUnavailableReason,
  details?: Record<string, unknown>,
): never {
  const message =
    reason === 'another_ingestion_in_flight'
      ? '另一个录入还在进行中，请等它结束后再试。'
      : '暂时无法确认录入助手的剩余额度，请稍后再试。';
  throw new ApiError(AGENT_BUDGET_UNAVAILABLE_CODE, message, 503, undefined, {
    reason,
    ...(details ?? {}),
  });
}

// ---------- 成本读取 ----------

export interface AgentWeekSpend {
  /** 本周可归因于 ingestion agent 的 USD 已知（reported|estimated|legacy）成本。 */
  usedUsd: number;
  /** 存在无法定额的归属内记录（unknown 基价 / 非 USD / NULL 币种）→ fail closed。 */
  unresolved: boolean;
  unresolvedRecords: number;
}

/**
 * 本周 agent 归属成本。归属规则（只计能证属于助手的，不把所有 OCR/任务都算进来）：
 *   - task_kind = 'IngestionAgentTask' 行（两源都算）：主 model run 的成本——
 *     cost_ledger 主 run 行与 provider_attempt 主 run 行由 canonical 投影的
 *     linked-attempt 规则去重，不会双计；
 *   - provider_attempt 行且 operation_id 以 `glm_ocr:ingestion_agent_tool`
 *     开头：GLM OCR 是 agent 唯一直接付费工具，anchor 内嵌 tool run id。
 * canonical 投影已做 provider_attempt 优先去重，这里不二次相加。
 * unknown 基价 / 非 USD（无可信折算）/ NULL 币种记录 → unresolved → 503。
 */
export async function readAgentWeekSpend(tx: Tx, from: Date, to: Date): Promise<AgentWeekSpend> {
  const rows = await tx.execute<{
    used_usd: number | null;
    unresolved_records: number;
  }>(sql`
    ${providerCostProjectedCte(from, to)}
    SELECT
      COALESCE(SUM(cost) FILTER (
        WHERE currency = 'USD' AND cost_basis IS DISTINCT FROM 'unknown'
      ), 0)::float8 AS used_usd,
      COUNT(*) FILTER (
        WHERE cost_basis = 'unknown' OR currency IS DISTINCT FROM 'USD'
      )::int AS unresolved_records
    FROM projected
    WHERE task_kind = ${AGENT_TASK_KIND}
       OR (source = 'provider_attempt' AND operation_id LIKE ${GLM_AGENT_ANCHOR_LIKE} ESCAPE '\\')
  `);
  const row = rows[0];
  const unresolved = (row?.unresolved_records ?? 0) > 0;
  return {
    usedUsd: row?.used_usd ?? 0,
    unresolved,
    unresolvedRecords: row?.unresolved_records ?? 0,
  };
}

// ---------- 配置读取（事务内权威读，不走进程快照） ----------

async function readBudgetLimit(tx: Tx): Promise<{ value: number; revision: number | null }> {
  const def = resolveKeyDef(BUDGET_CONFIG_KEY);
  if (!def || def.schema == null) budgetUnavailable('budget_read_unavailable');

  const [row] = await tx
    .select({ value: system_config.value, revision: system_config.revision })
    .from(system_config)
    .where(eq(system_config.key, BUDGET_CONFIG_KEY))
    .limit(1);

  if (row) {
    const parsed = def.schema.safeParse(row.value);
    if (!parsed.success || typeof parsed.data !== 'number') {
      budgetUnavailable('budget_read_unavailable');
    }
    return { value: parsed.data as number, revision: row.revision };
  }

  // DB 无行 → registry fallback 语义：env 显式值优先，其次 code default。
  const envRaw = def.envName != null ? process.env[def.envName] : undefined;
  if (envRaw !== undefined) {
    const envParsed = def.envParse ? def.envParse(envRaw) : envRaw;
    const validated = def.schema.safeParse(envParsed);
    if (validated.success && typeof validated.data === 'number') {
      return { value: validated.data as number, revision: null };
    }
    // env 显式给值但非法 → fail closed，不静默下探 default。
    budgetUnavailable('budget_read_unavailable');
  }
  return { value: def.codeDefault as number, revision: null };
}

// ---------- grant 写点 ----------

async function persistBudgetEnvelope(
  tx: Tx,
  sessionId: string,
  envelope: AgentBudgetEnvelope,
): Promise<void> {
  pruneSettledGrants(envelope);
  await tx
    .update(learning_session)
    .set({ agent_budget: envelope })
    .where(eq(learning_session.id, sessionId));
}

/** session 当前 in_flight grant（至多一个）。 */
function findInFlightGrant(
  envelope: AgentBudgetEnvelope | null,
): { operationId: string; grant: AgentBudgetGrant } | null {
  if (!envelope) return null;
  for (const [operationId, grant] of Object.entries(envelope.grants)) {
    if (grant.state === 'in_flight') return { operationId, grant };
  }
  return null;
}

async function hasLiveAgentJob(tx: Tx, sessionId: string): Promise<boolean> {
  const rows = await tx.execute<{ live: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM pgboss.job
      WHERE name = 'ingestion_agent_run'
        AND data->>'sessionId' = ${sessionId}
        AND state IN ${sql.raw(LIVE_AGENT_JOB_STATES)}
    ) AS live
  `);
  return rows[0]?.live === true;
}

// ---------- 对外接口 ----------

/**
 * 授权一次 agent 启动。只在 enqueueAgentRun 的 dispatch 事务内调用
 * （beforeTransition hook）；抛出即整个 dispatch 回滚（不翻转、不 send）。
 * 幂等：本 operation 已有 in_flight grant → 直接返回（同 handle 恢复不重复占位）。
 */
export async function authorizeAgentRunStart(
  tx: Tx,
  input: { sessionId: string; operationId: string },
): Promise<void> {
  // 先全局串行，再碰行数据——所有 start 判定同一次序，无锁次序分叉。
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_LOCK_KEY}))`);

  const now = new Date();
  const rows = await tx
    .select({
      id: learning_session.id,
      status: learning_session.status,
      agentBudget: learning_session.agent_budget,
    })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'ingestion'),
        sql`${learning_session.agent_budget} IS NOT NULL`,
      ),
    );

  // 1) 幂等复用：同 operation 的 in_flight grant → 放行（同一启动身份的
  //    恢复/重放不重复占位、不重复判定）。
  const ownRow = rows.find((r) => r.id === input.sessionId);
  const ownBudget = ownRow ? parseAgentBudget(ownRow.agentBudget) : null;
  if (ownRow && ownRow.agentBudget != null && ownBudget == null) {
    budgetUnavailable('budget_read_unavailable');
  }
  const ownInFlight = findInFlightGrant(ownBudget);
  if (ownInFlight?.operationId === input.operationId) return;

  // 2) 在途扫描（含本 session 的其它陈旧 grant）：in_flight grant 只在宿主
  //    session 仍可能继续时才占位；确证不可继续（run 已结束 / queued 但
  //    pg-boss 无活 job）的惰性 settle——不因时间/lease 过期猜。
  for (const row of rows) {
    const budget = row.id === input.sessionId ? ownBudget : parseAgentBudget(row.agentBudget);
    if (budget == null) {
      // 有 agent_budget 行但解析失败 → 无法证无在途 → fail closed。
      budgetUnavailable('budget_read_unavailable');
    }
    const inFlight = findInFlightGrant(budget);
    if (!inFlight) continue;
    if (RUN_OVER_SESSION_STATUSES.has(row.status)) {
      // run 已结束但 settle 未写（worker 崩溃边界）→ 惰性 settle 并让对应
      // operation 收到明确失败，不阻塞新启动。
      budget.grants[inFlight.operationId].state = 'settled';
      budget.grants[inFlight.operationId].settled_at = now.toISOString();
      budget.grants[inFlight.operationId].settle_reason = 'session_terminal';
      await persistBudgetEnvelope(tx, row.id, budget);
      await writeIngestionOperationTerminalOnce(tx, {
        operationId: inFlight.operationId,
        eventType: 'operation.failed',
        payload: {
          error: {
            code: 'session_terminal',
            message: `ingestion session reached '${row.status}' before this operation could run`,
            status: 500,
          },
          session_status: row.status,
        },
      });
      continue;
    }
    if (row.status === 'queued' && !(await hasLiveAgentJob(tx, row.id))) {
      // queued 但 pg-boss 侧无活 job：send 后 job 失败归档/未送达的 wedge ——
      // 只确证未发出才释放，不因时间/lease 过期猜。
      budget.grants[inFlight.operationId].state = 'settled';
      budget.grants[inFlight.operationId].settled_at = now.toISOString();
      budget.grants[inFlight.operationId].settle_reason = 'queue_vanished';
      await persistBudgetEnvelope(tx, row.id, budget);
      await writeIngestionOperationTerminalOnce(tx, {
        operationId: inFlight.operationId,
        eventType: 'operation.failed',
        payload: {
          error: {
            code: 'queue_vanished',
            message: 'queued dispatch has no live job — the operation can be retried',
            status: 503,
          },
        },
      });
      continue;
    }
    // 'queued' 有活 job / 'extracting'（含 suspended-on-ask，无 job 也是真在途）
    // / 'uploaded'（理论不可达：grant 与翻转同一事务）→ 明确拒绝。
    budgetUnavailable('another_ingestion_in_flight', { session_id: row.id });
  }

  // 2b) 预授权时代遗留：无 grant 但 agent lane 的 queued session 同样在途
  // （30 天 job_events 窗内可见 ingestion.queued lane='agent' 或 agent run 事件）。
  const legacy = await tx.execute<{ id: string }>(sql`
    SELECT s.id FROM learning_session s
    WHERE s.type = 'ingestion' AND s.id <> ${input.sessionId}
      AND s.status IN ('queued', 'extracting') AND s.agent_budget IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM job_events je
          WHERE je.business_table = 'ingestion_agent_run' AND je.business_id = s.id
        )
        OR EXISTS (
          SELECT 1 FROM job_events je
          WHERE je.business_table = 'ingestion_session' AND je.business_id = s.id
            AND je.event_type = 'ingestion.queued' AND je.payload->>'lane' = 'agent'
        )
      )
    LIMIT 1
  `);
  if (legacy.length > 0) {
    budgetUnavailable('another_ingestion_in_flight', { session_id: legacy[0].id });
  }

  // 3) 权威配置（事务内读行 + revision）。
  const limit = await readBudgetLimit(tx);
  if (limit.value <= 0) {
    // 显式 0 = kill switch：额度语义下 used(>=0) >= limit(0) 恒成立 → 429。
    budgetExceeded();
  }

  // 4) 本周成本：USD 已知计入；unknown/外币 → 503；used>=limit → 429。
  const week = learnerLocalWeekWindowUtc(now);
  const spend = await readAgentWeekSpend(tx, week.from, now);
  if (spend.unresolved) {
    budgetUnavailable('unsettled_cost', {
      unresolved_records: spend.unresolvedRecords,
    });
  }
  if (spend.usedUsd >= limit.value) {
    budgetExceeded();
  }

  // 5) 写 grant（与 session 翻转 + send 同事务提交/回滚）。
  const envelope: AgentBudgetEnvelope = ownBudget ?? {
    week_tz: AGENT_BUDGET_WEEK_TZ,
    grants: {},
  };
  envelope.grants[input.operationId] = {
    state: 'in_flight',
    week_start: week.from.toISOString(),
    limit_usd: limit.value,
    used_usd_at_grant: spend.usedUsd,
    config_revision: limit.revision,
    granted_at: now.toISOString(),
  };
  await persistBudgetEnvelope(tx, input.sessionId, envelope);
}

/**
 * run 终态 settle：in_flight grant → 'settled' + operation 终态事件。
 * 在 run.ts 各终态事务内调用（与状态翻转原子）；无 grant（预授权时代 run）
 * 则只补 operation 事件。幂等：已 settled / 已终态则 no-op。
 */
export async function settleAgentRunBudget(
  tx: Tx,
  input: {
    sessionId: string;
    /** job payload 带来的 operationId（resume/continue 可能没有 → 从 grant 反查）。 */
    operationId?: string;
    terminal: 'completed' | 'failed';
    /** failed 时的诚实原因；code 必填，message/status 缺省补齐。 */
    error?: { code: string; message?: string; status?: number; [k: string]: unknown };
    /** completed 时的 operation.result（投影字段）。 */
    result?: unknown;
  },
): Promise<void> {
  const [row] = await tx
    .select({ agentBudget: learning_session.agent_budget })
    .from(learning_session)
    .where(and(eq(learning_session.id, input.sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  if (!row) return;
  const budget = parseAgentBudget(row.agentBudget);
  const inFlight = findInFlightGrant(budget);
  const operationId = inFlight?.operationId ?? input.operationId;

  if (inFlight && budget) {
    budget.grants[inFlight.operationId].state = 'settled';
    budget.grants[inFlight.operationId].settled_at = new Date().toISOString();
    budget.grants[inFlight.operationId].settle_reason = 'run_terminal';
    await persistBudgetEnvelope(tx, input.sessionId, budget);
  }
  if (operationId) {
    const { code, message, status, ...extra } = input.error ?? { code: 'run_failed' };
    await writeIngestionOperationTerminalOnce(tx, {
      operationId,
      eventType: input.terminal === 'completed' ? 'operation.completed' : 'operation.failed',
      payload:
        input.terminal === 'completed'
          ? { result: input.result ?? {} }
          : {
              error: {
                code,
                message: message ?? code,
                status: status ?? 500,
                ...extra,
              },
            },
    });
  }
}

/** 第一 segment 起步时给 operation 投影补 'operation.running'（G6）。 */
export async function recordAgentOperationRunning(
  tx: Tx,
  input: { sessionId: string; operationId?: string },
): Promise<void> {
  const [row] = await tx
    .select({ agentBudget: learning_session.agent_budget })
    .from(learning_session)
    .where(and(eq(learning_session.id, input.sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  const budget = parseAgentBudget(row?.agentBudget);
  const operationId = findInFlightGrant(budget)?.operationId ?? input.operationId;
  if (!operationId) return;
  const existing = await tx.execute<{ has: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM job_events
      WHERE business_table = ${INGESTION_OPERATION_TABLE}
        AND business_id = ${operationId}
        AND event_type IN ('operation.running', 'operation.completed', 'operation.failed')
    ) AS has
  `);
  if (existing[0]?.has === true) return;
  await writeIngestionOperationEvent(tx, {
    operationId,
    eventType: 'operation.running',
    payload: {},
  });
}

// ---------- 启动身份（run.ts 用） ----------

/**
 * 归属判定：本 operation 是否拥有该 session 的 agent run。
 * 授权时代看 grant（in_flight/settled 都算——恢复语义下 settled 也是它派发的）；
 * 预授权时代看 pg-boss job data 里的 operationId（grant-less run 的唯一身份）。
 * 用于 dispatch 恢复路径：不是 run owner 的 op 永不可付费，须显式失败而非
 * 伪造 queued 僵尸 handle。
 */
export async function agentOpOwnsSessionRun(
  db: Db | Tx,
  sessionId: string,
  operationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ agentBudget: learning_session.agent_budget })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  const budget = parseAgentBudget(row?.agentBudget);
  if (budget && Object.hasOwn(budget.grants, operationId)) return true;
  const jobs = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM pgboss.job
      WHERE name = 'ingestion_agent_run'
        AND data->>'sessionId' = ${sessionId}
        AND data->>'operationId' = ${operationId}
    ) AS found
  `);
  return jobs[0]?.found === true;
}

/**
 * 本次启动的稳定身份 = in_flight grant 的 operation_id。
 * 无 grant（预授权时代 / 手工恢复）退化回 sessionId——run 级身份仍稳定。
 */
export async function resolveAgentRunRef(db: Db, sessionId: string): Promise<string> {
  const [row] = await db
    .select({ agentBudget: learning_session.agent_budget })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  return findInFlightGrant(parseAgentBudget(row?.agentBudget))?.operationId ?? sessionId;
}

/** 主 model run 的 task_run_id（segment 级确定性，重放不再生成新 run 行）。 */
export function agentRunTaskRunId(runRef: string, segment: number): string {
  return `ingestion_agent_run:${runRef}:seg:${segment}`;
}

/** tool 层 run id——GLM OCR anchor 用，前缀须与 GLM_AGENT_ANCHOR_LIKE 一致。 */
export function agentToolRunId(runRef: string, segment: number): string {
  return `${AGENT_TOOL_RUN_ID_PREFIX}:${runRef}:seg:${segment}`;
}
