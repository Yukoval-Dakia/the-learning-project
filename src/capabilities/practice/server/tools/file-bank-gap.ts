// YUK-1448 (Stage 1 batch D / 统一问题定级设计 §7+§9) — `file_bank_gap` DomainTool
// (effect:'write')。search_bank 检索不足（verdict sparse/none）时落缺口供题需求：
//
//   1. 幂等登记：request_id 派生确定性事件 id，写入既有供题台账（与 dispatcher 同一
//      experimental:question_supply action，status 恒为 'filed'/'held'——绝不写
//      'dispatched'，不污染 dispatcher 的 7d cooldown 凭证）。同 request_id + 同内容
//      → 重放已存回执（deduplicated=true）；同 id + 不同内容 → 显式 rejected。
//   2. retrieval_constraints（within_refs / source / kind / difficulty / KC，含
//      subject / exclude_refs / similar_to）随需求一并存档——缺口上下文完整可追溯。
//   3. 调用既有 dispatcher（dispatchSupplyTarget）。dispatcher 无法落实的限制 →
//      held/unsupported_constraint，绝不静默丢字段后假装已供题。
//
// 硬边界：不碰 learner state；不做教学决策；本工具自身零 LLM 调用（付费发生在
// 派出的 sourcing_web / quiz_gen job 内，受 dispatcher 指纹 cooldown 节流）。

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { canonicalKindToPersistedForms } from '@/subjects/question-kind';
import { type DispatchResult, dispatchSupplyTarget } from '../question-supply/dispatcher';
import {
  EvidenceDemandV1,
  type EvidenceDemandV1T,
  evidenceDemandToTargetContext,
} from '../question-supply/evidence-demand';
import {
  type DifficultyBand,
  type QuestionSupplyTarget,
  targetFingerprint,
} from '../question-supply/target-discovery';
import { BankGapRequestSchema, type BankSearchScope } from './bank-search';

// ── 输入 / 输出契约 ──────────────────────────────────────────────────────────

const FileBankGapInputSchema = z
  .object({
    /** 调用方生成的幂等键。同 id + 同内容重试回同一回执；同 id + 不同内容被拒。 */
    request_id: z.string().trim().min(1).max(200),
    /** 完整 EvidenceDemandV1（search_bank 的 gap_request 只是种子——agent 需补齐
     * demand_id / policy_version / subject_id / claim / evidence / task / difficulty /
     * inventory_goal.horizon_days / control 后提交）。 */
    demand: EvidenceDemandV1,
    /** search_bank 返回的固定检索证据（gap_request 原样）。 */
    search_evidence: BankGapRequestSchema,
  })
  .strict();

/** 从检索 scope 派生的供给约束存档（task 指定五轴 + 邻接轴，完整可追溯）。 */
export interface BankRetrievalConstraints {
  subject?: string;
  within_refs?: string[];
  source?: string;
  kind?: string;
  difficulty?: BankSearchScope['difficulty'];
  knowledge?: { ids: string[]; mode: 'any' | 'all' };
  exclude_refs?: string[];
  similar_to?: BankSearchScope['similar_to'];
}

function deriveRetrievalConstraints(scope: BankSearchScope): BankRetrievalConstraints {
  return {
    ...(scope.subject !== undefined ? { subject: scope.subject } : {}),
    ...(scope.within_refs !== undefined ? { within_refs: scope.within_refs } : {}),
    ...(scope.source !== undefined ? { source: scope.source } : {}),
    ...(scope.kind !== undefined ? { kind: scope.kind } : {}),
    ...(scope.difficulty !== undefined ? { difficulty: scope.difficulty } : {}),
    ...(scope.knowledge_ids !== undefined
      ? { knowledge: { ids: scope.knowledge_ids, mode: scope.knowledge_mode ?? 'any' } }
      : {}),
    ...(scope.exclude_refs !== undefined ? { exclude_refs: scope.exclude_refs } : {}),
    ...(scope.similar_to !== undefined ? { similar_to: scope.similar_to } : {}),
  };
}

const DispatchReceiptSchema = z.object({
  status: z.enum(['dispatched', 'manual', 'skipped', 'failed']),
  fingerprint: z.string(),
  chosen_route: z.string().nullable(),
  route_plan: z.array(z.string()),
  job_id: z.string().nullable(),
  stop_condition: z.string(),
});

const FileBankGapOutputSchema = z.object({
  demand_id: z.string(),
  /** true = 同 request_id + 同内容的重试，返回已存回执。 */
  deduplicated: z.boolean(),
  status: z.enum(['queued', 'held', 'rejected']),
  reason: z.string(),
  receipt: z.object({
    /** 台账事件 id（fbgap|<request_id>，确定性）。 */
    filing_event_id: z.string(),
    content_digest: z.string(),
    retrieval_constraints: z.object({
      subject: z.string().optional(),
      within_refs: z.array(z.string()).optional(),
      source: z.string().optional(),
      kind: z.string().optional(),
      difficulty: z.unknown().optional(),
      knowledge: z.object({ ids: z.array(z.string()), mode: z.enum(['any', 'all']) }).optional(),
      exclude_refs: z.array(z.string()).optional(),
      similar_to: z.unknown().optional(),
    }),
    /** held/unsupported_constraint 时列出无法落实的限制及原因。 */
    unsupported_constraints: z.array(z.string()).optional(),
    dispatch: DispatchReceiptSchema.optional(),
  }),
});

type FileBankGapInput = z.infer<typeof FileBankGapInputSchema>;
type FileBankGapOutput = z.infer<typeof FileBankGapOutputSchema>;
type DispatchReceipt = z.infer<typeof DispatchReceiptSchema>;

// ── dispatcher 可落实性判定（绝不静默丢字段）───────────────────────────────

function checkHonourableConstraints(scope: BankSearchScope, demand: EvidenceDemandV1T): string[] {
  const unsupported: string[] = [];
  if (scope.within_refs !== undefined) {
    unsupported.push(
      'within_refs: the dispatcher sources NEW supply; it cannot restrict sourcing to an existing ref pool',
    );
  }
  if (scope.source !== undefined) {
    unsupported.push('source: supply routes carry no source constraint');
  }
  if (scope.difficulty !== undefined) {
    unsupported.push(
      `difficulty: the dispatcher honours difficulty only as the demand band (difficulty.band='${demand.difficulty.band}'); a numeric ${scope.difficulty.basis} range [${scope.difficulty.range[0]}, ${scope.difficulty.range[1]}] cannot be guaranteed`,
    );
  }
  if (scope.exclude_refs !== undefined) {
    unsupported.push(
      'exclude_refs: dispatch payloads carry no exclusion list; duplicate-avoidance happens at the store/verify seam',
    );
  }
  if (scope.similar_to !== undefined) {
    unsupported.push(
      'similar_to: no supply route generates candidates constrained to resemble an anchor question',
    );
  }
  if (scope.knowledge_ids !== undefined) {
    const demandKcs = new Set(demand.claim.knowledge_ids);
    const outside = scope.knowledge_ids.filter((id) => !demandKcs.has(id));
    if (outside.length > 0) {
      unsupported.push(
        `knowledge: search KC scope exceeds demand.claim.knowledge_ids (${outside.join(', ')}); dispatching would silently narrow the demand`,
      );
    }
  }
  if (scope.kind !== undefined) {
    const covers =
      demand.task.kinds.includes('any') ||
      canonicalKindToPersistedForms(scope.kind).some((form) => demand.task.kinds.includes(form));
    if (!covers) {
      unsupported.push(
        `kind: search kind '${scope.kind}' is outside demand.task.kinds [${demand.task.kinds.join(', ')}]`,
      );
    }
  }
  return unsupported;
}

// ── 需求 → 供给目标（dispatcher 输入）──────────────────────────────────────

function buildBankGapTarget(
  demand: EvidenceDemandV1T,
  evidence: z.infer<typeof BankGapRequestSchema>,
  requestId: string,
): QuestionSupplyTarget {
  const [firstKind] = demand.task.kinds;
  const kind = demand.task.kinds.length === 1 && firstKind !== undefined ? firstKind : 'any';
  // eligible_count 是库存目标；requested_count 是本次检索的期望量——取较大者，
  // 并夹到 [1,10]（executor/quiz_gen 载荷的 count 上限）。
  const desiredCount = Math.min(
    10,
    Math.max(1, demand.inventory_goal.eligible_count || evidence.constraints.requested_count || 1),
  );
  return {
    id: `bankgap:${demand.demand_id}`,
    fingerprint: targetFingerprint({
      subjectId: demand.subject_id,
      knowledgeIds: demand.claim.knowledge_ids,
      kind,
      difficultyBand: demand.difficulty.band as DifficultyBand,
      gapKind: 'frontier_zero',
      minSourceTier: 2,
    }),
    gapKind: 'frontier_zero',
    subjectId: demand.subject_id,
    knowledgeIds: demand.claim.knowledge_ids,
    kind,
    difficultyBand: demand.difficulty.band as DifficultyBand,
    desiredCount,
    // bank gap = 找既有题失败的缺口：先 web 找现成题（tier 2），退而闭卷生成。
    minSourceTier: 2,
    routePreference: ['sourcing_web', 'quiz_gen'],
    priority: 50,
    reason: `bank search gap filed via file_bank_gap (request_id=${requestId}); query="${evidence.constraints.query}"; retrieved ${evidence.constraints.retrieved_count}/${evidence.constraints.requested_count}`,
    constraints: {},
    context: evidenceDemandToTargetContext(demand),
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

interface StoredFilingPayload {
  kind: 'bank_gap_filing';
  /** 台账存储态（filed=已派出/受理）；对外输出态 queued 映射 filed。 */
  status: 'filed' | 'held';
  reason: string;
  demand_id: string;
  content_digest: string;
  receipt: FileBankGapOutput['receipt'];
}

async function readStoredFiling(db: Db, eventId: string): Promise<StoredFilingPayload | null> {
  const [row] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, eventId))
    .limit(1);
  if (row == null) return null;
  return StoredFilingPayloadSchema.safeParse(row.payload).success
    ? (row.payload as unknown as StoredFilingPayload)
    : null;
}

const StoredFilingPayloadSchema = z.object({
  kind: z.literal('bank_gap_filing'),
  status: z.enum(['filed', 'held']),
  reason: z.string(),
  demand_id: z.string(),
  content_digest: z.string(),
  receipt: FileBankGapOutputSchema.shape.receipt,
});

function contentDigest(demand: EvidenceDemandV1T, evidence: z.infer<typeof BankGapRequestSchema>) {
  return createHash('sha256')
    .update(JSON.stringify({ demand, search_evidence: evidence }))
    .digest('hex');
}

function dispatchReceipt(result: DispatchResult): DispatchReceipt {
  return {
    status: result.status,
    fingerprint: result.fingerprint,
    chosen_route: result.chosenRoute,
    route_plan: result.routePlan,
    job_id: result.jobId,
    stop_condition: result.stopCondition,
  };
}

async function executeFileBankGap(ctx: ToolContext, rawInput: FileBankGapInput) {
  const input = FileBankGapInputSchema.parse(rawInput);
  const demand = EvidenceDemandV1.parse(input.demand);
  const evidence = BankGapRequestSchema.parse(input.search_evidence);
  const digest = contentDigest(demand, evidence);
  const eventId = `fbgap|${input.request_id}`;
  const scope = evidence.constraints.scope;
  const retrievalConstraints = deriveRetrievalConstraints(scope);

  // 幂等快路径：同 request_id 已登记 → 校验内容摘要后重放 / 拒绝。
  const stored = await readStoredFiling(ctx.db, eventId);
  if (stored) {
    if (stored.content_digest === digest) {
      return FileBankGapOutputSchema.parse({
        demand_id: stored.demand_id,
        deduplicated: true,
        status: stored.status === 'filed' ? 'queued' : 'held',
        reason: stored.reason,
        receipt: stored.receipt,
      });
    }
    return FileBankGapOutputSchema.parse({
      demand_id: demand.demand_id,
      deduplicated: false,
      status: 'rejected',
      reason:
        'request_id already filed with DIFFERENT content; keep the original filing or use a new request_id',
      receipt: {
        filing_event_id: eventId,
        content_digest: digest,
        retrieval_constraints: retrievalConstraints,
      },
    });
  }

  const writeFiling = async (payload: StoredFilingPayload) => {
    await writeEvent(ctx.db, {
      id: eventId,
      actor_kind: ctx.callerActor.kind,
      actor_ref: ctx.callerActor.ref,
      action: 'experimental:question_supply',
      subject_kind: 'query',
      subject_id: demand.demand_id,
      outcome: payload.status === 'filed' ? 'success' : 'partial',
      caused_by_event_id: ctx.causedByEventId ?? null,
      payload,
    });
  };

  const unsupported = checkHonourableConstraints(scope, demand);
  if (unsupported.length > 0) {
    // dispatcher 无法落实某限制 → held：需求照常入台账（供人工/未来路由接手），
    // 但绝不静默丢字段后假装已供题。
    const receipt: FileBankGapOutput['receipt'] = {
      filing_event_id: eventId,
      content_digest: digest,
      retrieval_constraints: retrievalConstraints,
      unsupported_constraints: unsupported,
    };
    const reason = `unsupported_constraint: ${unsupported.length} retrieval constraint(s) the dispatcher cannot honour (see receipt.unsupported_constraints)`;
    await writeFiling({
      kind: 'bank_gap_filing',
      status: 'held',
      reason,
      demand_id: demand.demand_id,
      content_digest: digest,
      receipt,
    });
    return FileBankGapOutputSchema.parse({
      demand_id: demand.demand_id,
      deduplicated: false,
      status: 'held',
      reason,
      receipt,
    });
  }

  const target = buildBankGapTarget(demand, evidence, input.request_id);
  const dispatch = await dispatchSupplyTarget(ctx.db, target, {
    actorRef: 'file_bank_gap',
  });
  const queued = dispatch.status === 'dispatched';
  const receipt: FileBankGapOutput['receipt'] = {
    filing_event_id: eventId,
    content_digest: digest,
    retrieval_constraints: retrievalConstraints,
    dispatch: dispatchReceipt(dispatch),
  };
  const reason = queued
    ? `dispatched via ${dispatch.chosenRoute} (job ${dispatch.jobId}); satisfied when ${target.desiredCount} verified question(s) land`
    : `${dispatch.status}: ${dispatch.stopCondition}`;
  await writeFiling({
    kind: 'bank_gap_filing',
    status: queued ? 'filed' : 'held',
    reason,
    demand_id: demand.demand_id,
    content_digest: digest,
    receipt,
  });
  // writeEvent first-write-wins：并发同 request_id 时以已存行为准回放。
  const canonical = (await readStoredFiling(ctx.db, eventId)) ?? undefined;
  const effective = canonical?.content_digest === digest ? canonical : undefined;
  if (effective != null && effective.receipt !== receipt) {
    return FileBankGapOutputSchema.parse({
      demand_id: effective.demand_id,
      deduplicated: true,
      status: effective.status === 'filed' ? 'queued' : 'held',
      reason: effective.reason,
      receipt: effective.receipt,
    });
  }
  return FileBankGapOutputSchema.parse({
    demand_id: demand.demand_id,
    deduplicated: false,
    status: queued ? 'queued' : 'held',
    reason,
    receipt,
  });
}

export const fileBankGapTool: DomainTool<FileBankGapInput, FileBankGapOutput> = {
  name: 'file_bank_gap',
  description:
    "File a question-supply demand for a bank search gap (search_bank coverage.verdict sparse/none). Input: request_id (your idempotency key), the full EvidenceDemandV1 (search_bank's gap_request is only a seed — you must add demand_id/policy_version/subject_id/claim/evidence/task/difficulty/inventory_goal.horizon_days/control), and the fixed search evidence (the gap_request object verbatim). Idempotent: same request_id + same content replays the stored receipt; same request_id + different content is rejected. The demand plus its retrieval constraints (within_refs/source/kind/difficulty/KC) are ledgered, then the existing supply dispatcher is called. If the dispatcher cannot honour a constraint the result is held/unsupported_constraint — fields are never silently dropped. Output: demand_id, deduplicated, queued|held, reason, business receipt (ledger event id + dispatch outcome).",
  effect: 'write',
  inputSchema: FileBankGapInputSchema,
  outputSchema: FileBankGapOutputSchema,
  costClass: 'local',
  execute: executeFileBankGap,
  summarize: (_input, output) =>
    `bank gap ${output.demand_id} → ${output.status}${output.deduplicated ? ' (replay)' : ''}`,
  mirrorEvent: 'when_causal',
};
