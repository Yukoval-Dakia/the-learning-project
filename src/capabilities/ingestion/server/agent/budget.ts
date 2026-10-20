// YUK-1522 — ingestion-agent 周预算生命周期服务（LIGHT 启动额度门）。
//
// 本服务只回答一个问题：能不能开始一次付费 agent run。判定发生在
// `authorizeAgentRunStart`——它在 dispatch 事务（enqueueAgentRun 的
// beforeTransition hook）内运行，先拿全局 advisory lock 串行所有
// start 判定，然后做五件事：
//   1) 幂等复用——本 operation 已有 grant（任何状态）→ 同一启动身份，直接放行；
//      同 key 的 durable 绑定命中 → 重放原 handle（AgentBudgetReplayError），
//      不同输入 → 409，旧无 key 证据的 grant 对带 key 请求 → 503 不静默新发；
//   2) 在途扫描——其它 session 仍有 in_flight grant → 503
//      another_ingestion_in_flight；awaiting_cost 或确证不可继续的旧 grant 经
//      费用终态判定惰性 settle／保留待结算 → 503 unsettled_cost；
//   3) 费用终态——真实 task/attempt 未结（ai_task_runs running / bound
//      provider_attempt 已发未结）→ 未结费用占位不释放 → 503 unsettled_cost；
//   4) 权威配置——事务内直读 system_config 行 + revision，DB 无行时按
//      registry fallback 语义读 env → code default；
//   5) 本周成本——canonical provider-cost 投影按归属规则过滤；USD 已知成本
//      计入 used，unknown/非 USD/无归属依据的相关记录 → 503（不按 0），
//      used >= limit → 429。
//
// 执行终态 ≠ 费用结清：settle 时先判「确证未发出/费用已落定」，未结清则
// grant → 'awaiting_cost'（占位持久保留，operation 仍如实终态），后续授权
// 每次惰性重评；只有 canonical 成本落定或确证从未发送才转 'settled'。
// 不靠 nightly 补账，不按 job 消失认定未发送，不把缺 ledger 当 0。
//
// grant 持久在 learning_session.agent_budget（job_events 有 30 天清理，
// 不能当授权身份的唯一真相），与 session 'queued' 翻转 + boss.send 在同一
// 事务提交；事务回滚则授权同时消失，不存在悬空占位。durable 幂等权威
// （key 摘要 + 输入摘要 + 原 operation/run 身份 + 终态）随 grant 持久，
// 不随 job_events TTL 或回执裁剪消失。
//
// GLM OCR 等直接付费工具的归属不靠 anchor 猜：tool 在 wire 调用前把
// provider operation_id 持久绑定进归因表（bindAgentProviderAttempt，
// provider_attempt 行在 acquire 时即带同一 operation_id），成本与未结
// 判定都按真实绑定筛选。绑定写入早于发送，崩溃窗口内要么绑定+attempt
// 行都在、要么绑定在而 attempt 行不在（证未发出）。
//
// resume/continue 不经此门：run.ts 用 grant 取回同一次启动身份
// （resolveAgentRunRef），不新造授权。run 终态统一走 settleAgentRunBudget。
//
// 周口径：Asia/Shanghai 自然周一 00:00（含）到下周一 00:00（不含），见
// src/core/learner-day.ts。跨周仍在途/待结算的 grant 不因周切换放行另一
// 新 run——先看 grant.state，不看 week_start。
//
// 错误契约（ingestion manifest 已登记 429/503）：
//   429 ingestion_weekly_budget_exceeded   used_usd >= limit_usd
//   503 ingestion_weekly_budget_unavailable
//        details.reason ∈ another_ingestion_in_flight | unsettled_cost |
//        budget_read_unavailable
//
// 写面 owner：本文件是 learning_session.agent_budget 的唯一写点；所有
// 变更走 jsonb_set 路径级原子写（grants/attributions 互不覆盖）。

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { resolveKeyDef } from '@/core/config/registry';
import { learnerLocalWeekWindowUtc } from '@/core/learner-day';
import type { Db, Tx } from '@/db/client';
import { learning_session, system_config } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { providerCostProjectedCte } from '@/kernel/read-models/provider-cost-projection';
import type { IngestionOperationResource } from '../operation-store';
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
 * run 已结束（其 grant 理应已 settled，残留者走费用终态判定惰性收口）。
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

/**
 * run.ts 把 toolCtx.taskRunId 定为 `agentToolRunId(runRef, segment)`（确定性）。
 * 直接付费工具在 wire 调用前把真实 provider operation_id 绑定进归因表，
 * 前缀仅用于识别「这是 agent 工具的 task run」，不参与费用筛选。
 */
export const AGENT_TOOL_RUN_ID_PREFIX = 'ingestion_agent_tool';
const AGENT_RUN_ID_PREFIX = 'ingestion_agent_run';
const AGENT_TASK_KIND = 'IngestionAgentTask';
const AGENT_JOB_NAME = 'ingestion_agent_run';

// ---------- 持久信封（learning_session.agent_budget jsonb） ----------

const operationErrorSchema = z
  .object({ code: z.string(), message: z.string(), status: z.number() })
  .passthrough();

const agentBudgetGrantSchema = z.object({
  /**
   * 'in_flight'：授权仍占位（在跑/排队）；
   * 'awaiting_cost'：执行终态已到但费用未证结清——占位持久保留，授权时惰性重评；
   * 'settled'：生命周期结束（费用落定或确证从未发送）。
   */
  state: z.enum(['in_flight', 'awaiting_cost', 'settled']),
  /** 授权所在周（Asia/Shanghai）起点 UTC 瞬时；收据字段，不参与放行判定。 */
  week_start: z.string(),
  /** 授权瞬时读到的限额与已用额（收据）。 */
  limit_usd: z.number(),
  used_usd_at_grant: z.number(),
  /** 授权瞬时 system_config.revision；env/code-default 层为 null。 */
  config_revision: z.number().int().nullable(),
  granted_at: z.string(),
  settled_at: z.string().optional(),
  /**
   * 终态 settle 原因：run_terminal | session_terminal | queue_vanished |
   * cost_resolved（awaiting_cost 惰性重评后落定）。
   */
  settle_reason: z.string().optional(),
  /**
   * durable 幂等绑定：sha256(Idempotency-Key)。null = 本特性上线后授权的
   * 无 key 请求；字段缺失（undefined）= 上线前旧 grant，key 不可证。
   */
  key_digest: z.string().nullable().optional(),
  /** 规范化请求输入摘要（与 operation-store 的 inputHash 同一 sha256）。 */
  input_digest: z.string().optional(),
  /** 原 operation 的可轮询终态（durable readback/replay 合成依据）。 */
  op_status: z.enum(['accepted', 'running', 'completed', 'failed']).optional(),
  op_error: operationErrorSchema.optional(),
  op_result: z.unknown().optional(),
  op_updated_at: z.string().optional(),
});
export type AgentBudgetGrant = z.infer<typeof agentBudgetGrantSchema>;

/**
 * 直接付费工具的持久归属绑定：wire 调用前写入，attempt 行在 acquire 时
 * 携带同一 operation_id——绑定与 attempt 行共同构成「已发」证据链。
 */
const agentBudgetAttributionSchema = z.object({
  /** provider_attempt.operation_id（uuid text）。 */
  operation_id: z.string(),
  /** 确定性 tool run id（`ingestion_agent_tool:<runRef>:seg:<n>`）。 */
  task_run_id: z.string(),
  tool: z.string(),
  bound_at: z.string(),
});
export type AgentBudgetAttribution = z.infer<typeof agentBudgetAttributionSchema>;

const agentBudgetEnvelopeSchema = z.object({
  week_tz: z.literal(AGENT_BUDGET_WEEK_TZ),
  /** operation_id → grant。幂等权威随 grant 持久，不按数量裁剪。 */
  grants: z.record(z.string(), agentBudgetGrantSchema),
  /** 直接工具调用的持久归属绑定，append-only，不裁剪。 */
  attributions: z.array(agentBudgetAttributionSchema).optional(),
});
export type AgentBudgetEnvelope = z.infer<typeof agentBudgetEnvelopeSchema>;

function parseAgentBudget(raw: unknown): AgentBudgetEnvelope | null {
  if (raw == null) return null;
  const parsed = agentBudgetEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
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

/**
 * 授权事务内发现同 key 的 durable 绑定 → 本次启动是重放，不新授权。
 * operations 捕获后返回原 handle（200），并把重复创建的 op 显式终态化。
 */
export class AgentBudgetReplayError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super(`idempotent replay: agent run already bound to operation ${operationId}`);
    this.name = 'AgentBudgetReplayError';
    this.operationId = operationId;
  }
}

// ---------- 成本读取 ----------

export interface AgentWeekSpend {
  /** 本周可归因于 ingestion agent 的 USD 已知（reported|estimated|legacy）成本。 */
  usedUsd: number;
  /** 存在无法定额的归属内记录（unknown 基价 / 非 USD / NULL 币种）→ fail closed。 */
  unresolved: boolean;
  unresolvedRecords: number;
}

/** 归属内 provider attempt 绑定集（所有 session 的持久归因，append-only）。 */
const BOUND_OPERATION_IDS_SQL = sql`
  SELECT a->>'operation_id' AS operation_id
  FROM learning_session s,
    jsonb_array_elements(COALESCE(s.agent_budget->'attributions', '[]'::jsonb)) a
  WHERE s.type = 'ingestion' AND s.agent_budget IS NOT NULL
`;

/**
 * 本周 agent 归属成本。归属规则（只计能证属于助手的，不把所有 OCR/任务都算进来）：
 *   - task_kind = 'IngestionAgentTask' 行（两源都算）：主 model run 的成本——
 *     cost_ledger 主 run 行与 provider_attempt 主 run 行由 canonical 投影的
 *     linked-attempt 规则去重，不会双计；
 *   - provider_attempt 行且 operation_id ∈ 持久归因绑定集：GLM OCR 等直接
 *     付费工具在 wire 调用前把真实 operation_id 写入
 *     learning_session.agent_budget.attributions，不靠 anchor 前缀猜、
 *     不把全体 OCR 收进来。早于绑定存在的旧 attempt 无归属证据，不可判
 *     （发行说明已如实披露该不可证窗口）。
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
       OR (source = 'provider_attempt' AND operation_id IN (${BOUND_OPERATION_IDS_SQL}))
  `);
  const row = rows[0];
  const unresolved = (row?.unresolved_records ?? 0) > 0;
  return {
    usedUsd: row?.used_usd ?? 0,
    unresolved,
    unresolvedRecords: row?.unresolved_records ?? 0,
  };
}

/**
 * 全局未结费用证据（真实 task/attempt 未结 → 缺 ledger 不当 0）：
 *   - 任一 IngestionAgentTask 的 ai_task_runs 仍 'running'：终态与 ledger
 *     行同一事务提交（writeAiTaskAttemptFinished），'running' = 尚无成本
 *     终态，可能是已发未知或孤儿 attempt → 未结；
 *   - 任一归属绑定内的 provider_attempt 已 reserve provider start 但未
 *     finish：确证已发出且结果未知 → 未结。
 * 绑定存在但 attempt 行不存在 / 已 finish 不具权威（wire_count=0 等）
 * → 证未发出，不算未结。
 */
export async function hasUnresolvedAgentSpend(
  tx: Tx,
): Promise<{ unsettled: boolean; openTaskRuns: number; openAttempts: number }> {
  const rows = await tx.execute<{ open_task_runs: number; open_attempts: number }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM ai_task_runs
        WHERE task_kind = ${AGENT_TASK_KIND} AND status = 'running') AS open_task_runs,
      (SELECT COUNT(*)::int FROM provider_attempt pa
        WHERE pa.finished_at IS NULL AND pa.provider_start_reserved_at IS NOT NULL
          AND pa.operation_id::text IN (${BOUND_OPERATION_IDS_SQL})) AS open_attempts
  `);
  const row = rows[0];
  const openTaskRuns = row?.open_task_runs ?? 0;
  const openAttempts = row?.open_attempts ?? 0;
  return { unsettled: openTaskRuns + openAttempts > 0, openTaskRuns, openAttempts };
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

// ---------- grant 写点（路径级原子，与 attributions 追加互不覆盖） ----------

/** 信封规范化底：列级 NULL 或缺字段时补出 schema 合法骨架（不改已有内容）。 */
const AGENT_BUDGET_BASE_SQL = sql`
  jsonb_set(
    jsonb_set(
      jsonb_set(
        COALESCE(agent_budget, '{}'::jsonb),
        '{week_tz}', to_jsonb(${AGENT_BUDGET_WEEK_TZ}::text), true
      ),
      '{grants}', COALESCE(agent_budget->'grants', '{}'::jsonb), true
    ),
    '{attributions}', COALESCE(agent_budget->'attributions', '[]'::jsonb), true
  )
`;

/**
 * 单 grant 的原子写：jsonb_set 只碰 `{grants,<opId>}` 路径，不读改写整个
 * 信封——授权/惰性 settle/run 终态写并发时不会覆盖 append-only 的
 * attributions 或其它 grant 路径。
 */
async function persistGrant(
  tx: Tx,
  sessionId: string,
  operationId: string,
  grant: AgentBudgetGrant,
): Promise<void> {
  await tx.execute(sql`
    UPDATE learning_session
    SET agent_budget = jsonb_set(
      ${AGENT_BUDGET_BASE_SQL},
      ARRAY['grants', ${operationId}], ${JSON.stringify(grant)}::jsonb, true
    )
    WHERE id = ${sessionId} AND type = 'ingestion'
  `);
}

/**
 * 直接付费工具的持久归属绑定（wire 调用前写）。append-only + operation_id
 * 去重；attempt 行随后于 acquire 携带同一 operation_id——绑定先于发送
 * 持久，崩溃不丢归属。
 */
export async function bindAgentProviderAttempt(
  db: Db,
  input: {
    sessionId: string;
    /** providerAttempt.operationId（anchor 确定性散列后的 uuid）。 */
    operationId: string;
    taskRunId: string;
    tool: string;
  },
): Promise<void> {
  const attribution = JSON.stringify({
    operation_id: input.operationId,
    task_run_id: input.taskRunId,
    tool: input.tool,
    bound_at: new Date().toISOString(),
  } satisfies AgentBudgetAttribution);
  const probe = JSON.stringify([{ operation_id: input.operationId }]);
  await db.execute(sql`
    UPDATE learning_session
    SET agent_budget = jsonb_set(
      ${AGENT_BUDGET_BASE_SQL},
      '{attributions}',
      COALESCE(agent_budget->'attributions', '[]'::jsonb) || ${attribution}::jsonb
    )
    WHERE id = ${input.sessionId} AND type = 'ingestion'
      AND NOT COALESCE(agent_budget->'attributions', '[]'::jsonb)
            @> ${probe}::jsonb
  `);
}

/** session 当前未终结 grant（in_flight 或 awaiting_cost，至多一个）。 */
function findOpenGrant(
  envelope: AgentBudgetEnvelope | null,
): { operationId: string; grant: AgentBudgetGrant } | null {
  if (!envelope) return null;
  for (const [operationId, grant] of Object.entries(envelope.grants)) {
    if (grant.state !== 'settled') return { operationId, grant };
  }
  return null;
}

async function hasLiveAgentJob(tx: Tx, sessionId: string): Promise<boolean> {
  const rows = await tx.execute<{ live: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM pgboss.job
      WHERE name = ${AGENT_JOB_NAME}
        AND data->>'sessionId' = ${sessionId}
        AND state IN ${sql.raw(LIVE_AGENT_JOB_STATES)}
    ) AS live
  `);
  return rows[0]?.live === true;
}

/**
 * 费用终态判定并收口 grant：真实 task/attempt 未结 → 'awaiting_cost'
 * （占位保留）；费用落定或确证从未发送 → 'settled'。operation 终态事件
 * 与 grant 的 op_status/op_error/op_result 同步持久（durable readback）。
 */
async function finalizeGrant(
  tx: Tx,
  sessionId: string,
  operationId: string,
  grant: AgentBudgetGrant,
  input: {
    settleReason: string;
    opTerminal?: {
      status: 'completed' | 'failed';
      error?: { code: string; message: string; status: number };
      result?: unknown;
    };
  },
): Promise<'settled' | 'awaiting_cost'> {
  const spend = await hasUnresolvedAgentSpend(tx);
  const now = new Date().toISOString();
  const next: AgentBudgetGrant = {
    ...grant,
    state: spend.unsettled ? 'awaiting_cost' : 'settled',
    settle_reason: input.settleReason,
    ...(input.opTerminal
      ? {
          op_status: input.opTerminal.status,
          ...(input.opTerminal.error ? { op_error: input.opTerminal.error } : {}),
          ...(input.opTerminal.result !== undefined ? { op_result: input.opTerminal.result } : {}),
          op_updated_at: now,
        }
      : {}),
    ...(spend.unsettled ? {} : { settled_at: now }),
  };
  await persistGrant(tx, sessionId, operationId, next);
  if (input.opTerminal) {
    await writeIngestionOperationTerminalOnce(tx, {
      operationId,
      eventType:
        input.opTerminal.status === 'completed' ? 'operation.completed' : 'operation.failed',
      payload:
        input.opTerminal.status === 'completed'
          ? { result: input.opTerminal.result ?? {} }
          : { error: input.opTerminal.error },
    });
  }
  return spend.unsettled ? 'awaiting_cost' : 'settled';
}

// ---------- 对外接口 ----------

/**
 * 授权一次 agent 启动。只在 enqueueAgentRun 的 dispatch 事务内调用
 * （beforeTransition hook）；抛出即整个 dispatch 回滚（不翻转、不 send）。
 * 幂等：本 operation 已有 grant → 同一启动身份直接返回；同 key 命中
 * durable 绑定 → AgentBudgetReplayError（重放，不新授权）。
 */
export async function authorizeAgentRunStart(
  tx: Tx,
  input: {
    sessionId: string;
    operationId: string;
    /** Idempotency-Key（原文只在内存用，落库的是 sha256 摘要）。 */
    idempotencyKey?: string;
    /** 规范化请求输入摘要（与 reservation 的 inputHash 一致）。 */
    inputDigest?: string;
  },
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

  const ownRow = rows.find((r) => r.id === input.sessionId);
  const ownBudget = ownRow ? parseAgentBudget(ownRow.agentBudget) : null;
  if (ownRow && ownRow.agentBudget != null && ownBudget == null) {
    budgetUnavailable('budget_read_unavailable');
  }

  // 1) 同一启动身份：本 operation 已有 grant（in_flight/awaiting_cost/settled
  //    都算——它是这次授权留下的身份）→ 恢复/重放不重复占位、不重复判定。
  if (ownBudget != null && Object.hasOwn(ownBudget.grants, input.operationId)) return;

  // 1b) durable 幂等绑定：job_events 30 天清理后仍须能证同 key → 原 handle。
  //     带 key 的旧无绑定 grant 无法证非 → 不静默新发，fail closed。
  const keyDigest = input.idempotencyKey ? agentKeyDigest(input.idempotencyKey) : undefined;
  if (keyDigest !== undefined && ownBudget != null) {
    for (const [opId, grant] of Object.entries(ownBudget.grants)) {
      if (grant.key_digest === keyDigest) {
        if (grant.input_digest === input.inputDigest) {
          throw new AgentBudgetReplayError(opId);
        }
        throw new ApiError(
          'idempotency_conflict',
          `Idempotency-Key is already bound to operation ${opId}`,
          409,
        );
      }
    }
    if (Object.values(ownBudget.grants).some((g) => g.key_digest === undefined)) {
      // 旧身份无证（绑定特性前的 grant）→ 无法证明本 key 不是它的重放，
      // 不许静默当作一次新付费启动。
      budgetUnavailable('budget_read_unavailable');
    }
  }

  // 2) 在途/待结算扫描（含本 session 的其它陈旧 grant）：
  //    in_flight 只在宿主 session 仍可能继续时才占位；确证不可继续的走
  //    费用终态判定（未结清 → awaiting_cost，占位仍阻新启动）。
  for (const row of rows) {
    const budget = row.id === input.sessionId ? ownBudget : parseAgentBudget(row.agentBudget);
    if (budget == null) {
      // 有 agent_budget 行但解析失败 → 无法证无在途 → fail closed。
      budgetUnavailable('budget_read_unavailable');
    }
    const open = findOpenGrant(budget);
    if (!open) continue;

    if (open.grant.state === 'awaiting_cost') {
      // 待结算占位惰性重评：仍未结 → 继续阻；已落定 → 收口放行。
      const spend = await hasUnresolvedAgentSpend(tx);
      if (spend.unsettled) {
        budgetUnavailable('unsettled_cost', {
          session_id: row.id,
          open_task_runs: spend.openTaskRuns,
          open_attempts: spend.openAttempts,
        });
      }
      await persistGrant(tx, row.id, open.operationId, {
        ...open.grant,
        state: 'settled',
        settled_at: now.toISOString(),
        settle_reason: 'cost_resolved',
      });
      continue;
    }

    if (RUN_OVER_SESSION_STATUSES.has(row.status)) {
      // run 已结束但 settle 未写（worker 崩溃边界）→ 费用终态判定后收口；
      // 对应 operation 收到明确失败，未结清则占位转 awaiting_cost。
      const state = await finalizeGrant(tx, row.id, open.operationId, open.grant, {
        settleReason: 'session_terminal',
        opTerminal: {
          status: 'failed',
          error: {
            code: 'session_terminal',
            message: `ingestion session reached '${row.status}' before this operation could run`,
            status: 500,
          },
        },
      });
      if (state === 'awaiting_cost') {
        budgetUnavailable('unsettled_cost', { session_id: row.id });
      }
      continue;
    }
    if (row.status === 'queued' && !(await hasLiveAgentJob(tx, row.id))) {
      // queued 但 pg-boss 侧无活 job：send 后 job 失败归档/未送达的 wedge ——
      // job 消失不等于未发送（已 claim 后崩也可能），仍走费用终态判定。
      const state = await finalizeGrant(tx, row.id, open.operationId, open.grant, {
        settleReason: 'queue_vanished',
        opTerminal: {
          status: 'failed',
          error: {
            code: 'queue_vanished',
            message: 'queued dispatch has no live job — the operation can be retried',
            status: 503,
          },
        },
      });
      if (state === 'awaiting_cost') {
        budgetUnavailable('unsettled_cost', { session_id: row.id });
      }
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

  // 2c) 全局未结费用证据：无 grant 的孤儿 running attempt / bound attempt
  //     已发未结同样不放行（含 pre-gate 遗留与崩溃残留）。
  const unresolved = await hasUnresolvedAgentSpend(tx);
  if (unresolved.unsettled) {
    budgetUnavailable('unsettled_cost', {
      open_task_runs: unresolved.openTaskRuns,
      open_attempts: unresolved.openAttempts,
    });
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

  // 5) 写 grant（与 session 翻转 + send 同事务提交/回滚），附 durable
  //    幂等绑定：key 摘要 + 输入摘要 + operation/run 身份 + op 状态。
  await persistGrant(tx, input.sessionId, input.operationId, {
    state: 'in_flight',
    week_start: week.from.toISOString(),
    limit_usd: limit.value,
    used_usd_at_grant: spend.usedUsd,
    config_revision: limit.revision,
    granted_at: now.toISOString(),
    ...(keyDigest !== undefined ? { key_digest: keyDigest } : { key_digest: null }),
    ...(input.inputDigest !== undefined ? { input_digest: input.inputDigest } : {}),
    op_status: 'accepted',
    op_updated_at: now.toISOString(),
  });
}

/**
 * run 终态 settle：open grant 经费用终态判定 → 'settled'|'awaiting_cost' +
 * operation 终态事件（operation 可失败，但未结费用占位持久保留）。
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
  const open = findOpenGrant(budget);
  const operationId = open?.operationId ?? input.operationId;

  if (open && budget) {
    const { code, message, status, ...extra } = input.error ?? { code: 'run_failed' };
    const opError = {
      code,
      message: message ?? code,
      status: status ?? 500,
      ...extra,
    } as { code: string; message: string; status: number };
    await finalizeGrant(tx, input.sessionId, open.operationId, open.grant, {
      settleReason: 'run_terminal',
      opTerminal: {
        status: input.terminal,
        ...(input.terminal === 'completed' ? { result: input.result ?? {} } : { error: opError }),
      },
    });
  } else if (operationId) {
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

/** 第一 segment 起步时给 operation 投影补 'operation.running'（G6）+ grant op_status。 */
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
  const open = findOpenGrant(budget);
  const operationId = open?.operationId ?? input.operationId;
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
  const now = new Date().toISOString();
  if (open && budget && open.grant.op_status !== 'running') {
    await persistGrant(tx, input.sessionId, open.operationId, {
      ...open.grant,
      op_status: 'running',
      op_updated_at: now,
    });
  }
  await writeIngestionOperationEvent(tx, {
    operationId,
    eventType: 'operation.running',
    payload: {},
  });
}

// ---------- durable 幂等（reservation/replay/readback 共用） ----------

/** Idempotency-Key 的安全摘要（不落原文）。 */
export function agentKeyDigest(idempotencyKey: string): string {
  return createHash('sha256')
    .update('the-learning-project/ingestion-operation-key/v1\0')
    .update(idempotencyKey)
    .digest('hex');
}

/**
 * 按 key 摘要查 durable 绑定（job_events TTL 后的 replay 权威）。
 * 命中由调用方比对 input_digest：一致 → 重放原 handle；不一致 → 409。
 */
export async function findAgentGrantByKeyDigest(
  db: Db | Tx,
  input: { sessionId: string; keyDigest: string },
): Promise<{ operationId: string; grant: AgentBudgetGrant } | null> {
  const [row] = await db
    .select({ agentBudget: learning_session.agent_budget })
    .from(learning_session)
    .where(and(eq(learning_session.id, input.sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  const budget = parseAgentBudget(row?.agentBudget);
  if (!budget) return null;
  for (const [operationId, grant] of Object.entries(budget.grants)) {
    if (grant.key_digest === input.keyDigest) return { operationId, grant };
  }
  return null;
}

/**
 * 该 session 是否存在「无 key 绑定证据」的旧 grant（绑定特性前授权）。
 * 有此 grant 时带 key 的新请求无法证非重放 → fail closed，不静默新发。
 */
export async function hasUnboundAgentGrants(db: Db | Tx, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ agentBudget: learning_session.agent_budget })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  const budget = parseAgentBudget(row?.agentBudget);
  if (!budget) return false;
  return Object.values(budget.grants).some((g) => g.key_digest === undefined);
}

/** 从 durable grant 合成可轮询 operation 资源（事件已 TTL 的 readback）。 */
export function synthesizeAgentOperationResource(
  operationId: string,
  sessionId: string,
  grant: AgentBudgetGrant,
): IngestionOperationResource {
  const status =
    grant.op_status === 'completed'
      ? 'succeeded'
      : grant.op_status === 'failed'
        ? 'failed'
        : grant.op_status === 'running'
          ? 'running'
          : grant.state === 'settled'
            ? 'failed'
            : 'queued';
  const error =
    status === 'failed'
      ? (grant.op_error ?? {
          code: 'operation_failed',
          message: 'Operation failed',
          status: 500,
        })
      : undefined;
  return {
    id: operationId,
    kind: 'ingestion_operation',
    operation_kind: 'agent',
    status,
    session_id: sessionId,
    ...(status === 'succeeded' ? { result: grant.op_result ?? {} } : {}),
    ...(error ? { error } : {}),
    created_at: grant.granted_at,
    updated_at: grant.op_updated_at ?? grant.settled_at ?? grant.granted_at,
    events_url: `/api/jobs/${INGESTION_OPERATION_TABLE}/${encodeURIComponent(operationId)}/events`,
  };
}

/**
 * readback 兜底：按 operationId 反查 durable grant（jsonb ? 键存在）。
 * job_events TTL 清理后 agent operation 仍可读回真实终态。
 */
export async function readAgentOperationById(
  db: Db | Tx,
  operationId: string,
): Promise<IngestionOperationResource | null> {
  const rows = await db.execute<{ id: string; agent_budget: unknown }>(sql`
    SELECT id, agent_budget FROM learning_session
    WHERE type = 'ingestion'
      AND agent_budget IS NOT NULL
      AND agent_budget->'grants' ? ${operationId}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  const budget = parseAgentBudget(row.agent_budget);
  const grant = budget?.grants[operationId];
  if (!grant) return null;
  return synthesizeAgentOperationResource(operationId, row.id, grant);
}

// ---------- 启动身份（run.ts 用） ----------

/**
 * 归属判定：本 operation 是否拥有该 session 的 agent run。
 * 授权时代看 grant（任何状态都算——恢复语义下它也是它派发的）；
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
      WHERE name = ${AGENT_JOB_NAME}
        AND data->>'sessionId' = ${sessionId}
        AND data->>'operationId' = ${operationId}
    ) AS found
  `);
  return jobs[0]?.found === true;
}

/**
 * 本次启动的稳定身份 = 未终结 grant 的 operation_id（无 open grant 时扫
 * settled——已收口 run 的 resume/continue 仍属同一启动身份）。
 * 无 grant（预授权时代 / 手工恢复）退化回 sessionId——run 级身份仍稳定。
 */
export async function resolveAgentRunRef(db: Db, sessionId: string): Promise<string> {
  const [row] = await db
    .select({ agentBudget: learning_session.agent_budget })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
    .limit(1);
  const budget = parseAgentBudget(row?.agentBudget);
  const open = findOpenGrant(budget);
  if (open) return open.operationId;
  // jsonb 键序是字典序不是时间序——按 granted_at 取最后授权的 settled grant。
  let latest: { operationId: string; grantedAt: string } | null = null;
  for (const [operationId, grant] of Object.entries(budget?.grants ?? {})) {
    if (latest == null || grant.granted_at > latest.grantedAt) {
      latest = { operationId, grantedAt: grant.granted_at };
    }
  }
  return latest?.operationId ?? sessionId;
}

/** 主 run 的确定性 ai_task_runs.id（cost_ledger.task_run_id 同源）。 */
export function agentRunTaskRunId(runRef: string, segment: number): string {
  return `${AGENT_RUN_ID_PREFIX}:${runRef}:seg:${segment}`;
}

/** 直接付费工具的确定性 task run id（toolCtx.taskRunId）。 */
export function agentToolRunId(runRef: string, segment: number): string {
  return `${AGENT_TOOL_RUN_ID_PREFIX}:${runRef}:seg:${segment}`;
}
