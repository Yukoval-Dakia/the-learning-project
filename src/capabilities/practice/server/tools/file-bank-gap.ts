// Same-revision bank evidence and attributed caller judgments authorize a supply claim.
// The existing claim ledger and paid dispatch share one transaction; unknown or
// incomplete evidence never establishes bank absence or bypasses supply controls.

import { canonicalHash } from '@/core/migration/canonical';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { EvidenceDemandV1, type EvidenceDemandV1T } from '@/kernel/supply-contracts';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { canonicalKindToPersistedForms } from '@/subjects/question-kind';
import {
  BankAssessmentSchema,
  BankGapRequestSchema,
  type BankSearchScope,
  bankReceiptGapEvidence,
  verifyBankGapEvidenceMac,
} from '../../question-bank/public';
import {
  buildQuestionPreparerTarget,
  enqueueQuestionPreparerTicket,
  isUnanchoredSupplyPaused,
} from '../../supply/public';

// ── 输入 / 输出契约 ──────────────────────────────────────────────────────────

const FileBankGapInputSchema = z
  .object({
    /** 调用方生成的幂等键。同 id + 同内容重试回同一回执；同 id + 不同内容被拒。 */
    request_id: z.string().trim().min(1).max(200),
    /** Complete demand with the original request and explicit inventory target. */
    demand: EvidenceDemandV1,
    /** Server receipt identity; the caller cannot mint retrieval evidence. */
    search_id: z.string(),
    assessments: z.array(BankAssessmentSchema).max(200),
  })
  .strict();

/** 从检索 scope 派生的供给约束存档。 */
export interface BankRetrievalConstraints {
  subject?: string;
  within_refs?: string[];
  source?: string;
  kind?: string;
  kinds?: string[];
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
    ...(scope.kinds ? { kinds: scope.kinds } : {}),
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
      kinds: z.array(z.string()).optional(),
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

/** scope.kind 落到 dispatcher 的题型：必须是该 kind 的某个持久化形态，且在
 * demand.task.kinds 内（'any' 时取 scope.kind 本身的形态）。null = 无法落实。 */
function scopeTargetKind(scopeKind: string, demandKinds: string[]): string | null {
  const forms = canonicalKindToPersistedForms(scopeKind);
  if (demandKinds.includes('any'))
    return forms.includes(scopeKind) ? scopeKind : (forms[0] ?? null);
  return demandKinds.find((kind) => forms.includes(kind)) ?? null;
}

function scopeTargetKinds(scope: BankSearchScope, demandKinds: string[]): string[] | null {
  if (!scope.kinds) return null;
  if (scope.kinds.includes('any')) return demandKinds;
  const forms = [...new Set(scope.kinds.flatMap(canonicalKindToPersistedForms))];
  return demandKinds.includes('any') ? forms : demandKinds.filter((kind) => forms.includes(kind));
}

function checkHonourableConstraints(scope: BankSearchScope, demand: EvidenceDemandV1T): string[] {
  const unsupported: string[] = [];
  if (scope.subject !== undefined && scope.subject !== demand.subject_id) {
    unsupported.push(
      `subject: search subject '${scope.subject}' differs from demand.subject_id '${demand.subject_id}'`,
    );
  }
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
    if (scope.knowledge_mode !== 'all' && new Set(scope.knowledge_ids).size > 1) {
      unsupported.push(
        'knowledge: an any-KC union cannot become an all-KC preparer ticket; file separate demands or use a same-question all scope',
      );
    }
  }
  if (scope.kind !== undefined && scopeTargetKind(scope.kind, demand.task.kinds) === null) {
    unsupported.push(
      `kind: no persisted form of search kind '${scope.kind}' is within demand.task.kinds [${demand.task.kinds.join(', ')}]`,
    );
  }
  if (
    scope.kinds &&
    !scope.kinds.includes('any') &&
    scope.kinds.some((kind) => scopeTargetKind(kind, demand.task.kinds) === null)
  )
    unsupported.push('kinds: search and ticket allowed-type sets do not intersect');
  return unsupported;
}

// ── 需求 → 供给目标（dispatcher 输入）──────────────────────────────────────

function buildBankGapTarget(
  demand: EvidenceDemandV1T,
  evidence: z.infer<typeof BankGapRequestSchema>,
  requestId: string,
) {
  const scope = evidence.constraints.scope;
  // scope.kind 已由 checkHonourableConstraints 验证可落实；作为硬题型约束派出。
  // 调用方已把 demand 窄化到签名 scope，所以共享推导读到的 KC 集合/题型与旧局部分支一致。
  const scopeKind =
    scope.kind !== undefined ? scopeTargetKind(scope.kind, demand.task.kinds) : null;
  return buildQuestionPreparerTarget(demand, {
    requestedCount: evidence.constraints.requested_count,
    kindRequired: scopeKind !== null,

    reason: `bank search gap filed via file_bank_gap (request_id=${requestId}); query="${evidence.constraints.query}"; retrieved ${evidence.constraints.retrieved_count}/${evidence.constraints.requested_count}`,
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────

/** The signed search scope narrows the ticket exactly as the old dispatcher narrowed its
 *  target: the scope's KCs replace the demand claim set (the guard proved ⊆), and a stated
 *  scope kind becomes the ticket's only task kind. Without this the preparer would judge
 *  inventory and author against the broader demand. */
function narrowDemandToSignedScope(
  demand: EvidenceDemandV1T,
  evidence: z.infer<typeof BankGapRequestSchema>,
): EvidenceDemandV1T {
  const scope = evidence.constraints.scope;
  const knowledgeIds =
    scope.knowledge_ids !== undefined
      ? [...new Set(scope.knowledge_ids)]
      : demand.claim.knowledge_ids;
  const kind = scope.kind !== undefined ? scopeTargetKind(scope.kind, demand.task.kinds) : null;
  return EvidenceDemandV1.parse({
    ...demand,
    claim: {
      ...demand.claim,
      knowledge_ids: knowledgeIds,
      statement: [
        demand.claim.statement,
        ...(evidence.semantic_conditions ?? []).map(
          (c) => `${c.required ? 'required' : 'preferred'}: ${c.text}`,
        ),
      ].join('\n'),
    },
    task: {
      ...demand.task,
      kinds:
        scopeTargetKinds(scope, demand.task.kinds) ?? (kind !== null ? [kind] : demand.task.kinds),
    },
  });
}

interface StoredFilingPayload {
  kind: 'bank_gap_filing';
  decision_source?: 'caller_assessed';
  search_id?: string;
  assessment_digest?: string;
  input_digest?: string;
  /** 台账存储态。claimed = dispatch 路径的占位行（写在 `fbgap|<request_id>`，
   * first-write-wins 充当原子占位）；filed = 已派出 / held = 挂起（hold 路径的
   * 终态直接写 `fbgap|<request_id>`；dispatch 路径的终态追加到
   * `fbgap|<request_id>|receipt`）。绝不写 'dispatched'——不污染 dispatcher 的
   * cooldown 凭证。对外输出态 queued 映射 filed。 */
  status: 'claimed' | 'filed' | 'held';
  reason: string;
  demand_id: string;
  content_digest: string;
  /** 每次调用随机；回读相等 ⇔ 本次调用的写入赢得 first-write-wins。 */
  filing_nonce?: string;
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
  status: z.enum(['claimed', 'filed', 'held']),
  reason: z.string(),
  demand_id: z.string(),
  content_digest: z.string(),
  filing_nonce: z.string().optional(),
  receipt: FileBankGapOutputSchema.shape.receipt,
});

function contentDigest(demand: EvidenceDemandV1T, evidence: z.infer<typeof BankGapRequestSchema>) {
  return createHash('sha256')
    .update(JSON.stringify({ demand, search_evidence: evidence }))
    .digest('hex');
}

function dispatchReceipt(result: {
  status: DispatchReceipt['status'];
  fingerprint: string;
  jobId: string | null;
  stopCondition: string;
}): DispatchReceipt {
  return {
    status: result.status,
    fingerprint: result.fingerprint,
    chosen_route: 'question_preparer',
    route_plan: ['question_preparer'],
    job_id: result.jobId,
    stop_condition: result.stopCondition,
  };
}

async function executeFileBankGap(ctx: ToolContext, rawInput: FileBankGapInput) {
  const request = FileBankGapInputSchema.parse(rawInput);
  return ctx.db.transaction(async (tx) => {
    const inputDigest = canonicalHash({ request, actor: ctx.callerActor, run: ctx.taskRunId });
    const stored = await readStoredFiling(tx as unknown as Db, `fbgap|${request.request_id}`);
    if (stored) {
      const terminal =
        stored.status === 'claimed'
          ? await readStoredFiling(tx as unknown as Db, `fbgap|${request.request_id}|receipt`)
          : null;
      const prior = terminal ?? stored;
      if (stored.input_digest !== inputDigest)
        return FileBankGapOutputSchema.parse({
          demand_id: request.demand.demand_id,
          deduplicated: false,
          status: 'rejected',
          reason: 'request_id already filed with DIFFERENT content or owner',
          receipt: prior.receipt,
        });
      return FileBankGapOutputSchema.parse({
        demand_id: prior.demand_id,
        deduplicated: true,
        status: prior.status === 'filed' ? 'queued' : 'held',
        reason:
          prior.status === 'claimed'
            ? 'claimed_not_dispatched: existing claim has no terminal receipt; no redispatch'
            : prior.reason,
        receipt: prior.receipt,
      });
    }
    const observation = await bankReceiptGapEvidence(
      tx,
      ctx,
      request.search_id,
      request.assessments,
    );
    if (
      request.demand.inventory_goal.eligible_count !==
      observation.evidence.constraints.requested_count
    )
      throw new Error('file_bank_gap: inventory goal must match the searched requested count');
    if (request.demand.claim.statement !== observation.evidence.claim.statement)
      throw new Error('file_bank_gap: demand statement must preserve the searched request');
    // Drizzle's transaction implements the same query/write surface used by this operation.
    return fileBankGapWithEvidence(
      { ...ctx, db: tx as unknown as Db },
      {
        request_id: request.request_id,
        demand: request.demand,
        search_evidence: observation.evidence,
        input_digest: inputDigest,
      },
    );
  });
}
async function fileBankGapWithEvidence(
  ctx: ToolContext,
  input: {
    request_id: string;
    input_digest: string;
    demand: FileBankGapInput['demand'];
    search_evidence: z.infer<typeof BankGapRequestSchema>;
  },
) {
  const demand = EvidenceDemandV1.parse(input.demand);
  const evidence = BankGapRequestSchema.parse(input.search_evidence);
  const digest = contentDigest(demand, evidence);
  const eventId = `fbgap|${input.request_id}`;
  /** claim-first 协议的回执事件 id：dispatch 路径的终态只追加到这里（台账只增不改）。 */
  const receiptEventId = `${eventId}|receipt`;
  const scope = evidence.constraints.scope;
  const retrievalConstraints = deriveRetrievalConstraints(scope);

  // 检索证据必须由 search_bank 服务端签发（evidence_mac 防伪）——缺失或不符一律
  // rejected 且不落台账（伪造证据不配占用 request_id，更不可能触发付费 dispatch）。
  if (!verifyBankGapEvidenceMac(evidence)) {
    return FileBankGapOutputSchema.parse({
      demand_id: demand.demand_id,
      deduplicated: false,
      status: 'rejected',
      reason:
        'evidence_not_from_search_bank: search_evidence lacks a valid server-minted evidence_mac — pass a valid v3 search_id and cited assessments (fabricated evidence, e.g. a hand-written complete:true, can never trigger paid dispatch)',
      receipt: {
        filing_event_id: eventId,
        content_digest: digest,
        retrieval_constraints: retrievalConstraints,
      },
    });
  }

  // 已存台账（占位行 / 终态行）→ 同内容重放；不同内容（含并发同 request_id 异内容）
  // → rejected；'claimed' 占位行（winner 崩溃或仍在飞行中）→ held/
  // claimed_not_dispatched，绝不替它再派发。
  const respondToStored = (stored: StoredFilingPayload | null): FileBankGapOutput => {
    if (stored !== null && stored.content_digest === digest) {
      if (stored.status === 'claimed') {
        return FileBankGapOutputSchema.parse({
          demand_id: stored.demand_id,
          deduplicated: true,
          status: 'held',
          reason:
            'claimed_not_dispatched: this request_id was claimed by an earlier call but no dispatch receipt exists — it is either still in flight or crashed between claiming and dispatching. This call did NOT dispatch. The paid job may or may not have been enqueued; reconcile manually (dispatcher cooldown ledger for the target fingerprint / the job queue) and re-file under a NEW request_id only if no job went out',
          receipt: stored.receipt,
        });
      }
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
  };

  // 幂等快路径：同 request_id 已登记 → 校验内容摘要后重放 / 拒绝 / held。占位行
  // 存在时优先读回执事件（winner 可能已在本调用读取前完成派发）。
  const stored = await readStoredFiling(ctx.db, eventId);
  if (stored) {
    const receiptRow =
      stored.status === 'claimed' ? await readStoredFiling(ctx.db, receiptEventId) : null;
    return respondToStored(receiptRow ?? stored);
  }

  // 落台账并判定本次写入是否生效（writeEvent first-write-wins）：回读 nonce 相等
  // 才是本次调用登记；否则并发调用已先登记，按其内容摘要重放或拒绝。
  const filingNonce = randomUUID();
  const settleFiling = async (
    payload: Omit<StoredFilingPayload, 'kind' | 'demand_id' | 'content_digest' | 'filing_nonce'>,
  ): Promise<FileBankGapOutput> => {
    await writeEvent(ctx.db, {
      id: eventId,
      actor_kind: ctx.callerActor.kind,
      actor_ref: ctx.callerActor.ref,
      action: 'experimental:question_supply',
      subject_kind: 'query',
      subject_id: demand.demand_id,
      outcome: payload.status === 'filed' ? 'success' : 'partial',
      session_id: ctx.sessionId ?? null,
      caused_by_event_id: ctx.causedByEventId ?? null,
      payload: {
        kind: 'bank_gap_filing',
        input_digest: input.input_digest,
        search_id: evidence.search_id,
        assessment_digest: evidence.assessment_digest,
        decision_source: 'caller_assessed',
        demand_id: demand.demand_id,
        content_digest: digest,
        filing_nonce: filingNonce,
        ...payload,
      } satisfies StoredFilingPayload,
    });
    const canonical = await readStoredFiling(ctx.db, eventId);
    if (canonical?.filing_nonce !== filingNonce) return respondToStored(canonical);
    return FileBankGapOutputSchema.parse({
      demand_id: demand.demand_id,
      deduplicated: false,
      status: payload.status === 'filed' ? 'queued' : 'held',
      reason: payload.reason,
      receipt: payload.receipt,
    });
  };

  const unsupported = [
    ...checkHonourableConstraints(scope, demand),
    ...(evidence.unsupported_constraints ?? []),
  ];
  const retrievalComplete = evidence.complete && evidence.unavailable_channels.length === 0;
  // 需求控制先于任何派发：零/负预算或已过期的需求绝不触发付费 job。
  const budgetExhausted =
    demand.control.max_budget_micro_usd !== null && demand.control.max_budget_micro_usd <= 0;
  const deadlinePassed =
    demand.control.needed_by !== null && Date.parse(demand.control.needed_by) <= Date.now();
  const supplyPaused = isUnanchoredSupplyPaused();
  if (
    !retrievalComplete ||
    unsupported.length > 0 ||
    budgetExhausted ||
    deadlinePassed ||
    supplyPaused
  ) {
    // 检索不完整 / dispatcher 无法落实某限制 / 预算耗尽 / 截止时间已过 → held：需求
    // 照常入台账（供人工/未来路由接手），但绝不把没搜全当成缺题、绝不静默丢字段后
    // 假装已供题、绝不在零预算或过期截止下派出付费 job。
    const receipt: FileBankGapOutput['receipt'] = {
      filing_event_id: eventId,
      content_digest: digest,
      retrieval_constraints: retrievalConstraints,
      ...(unsupported.length > 0 ? { unsupported_constraints: unsupported } : {}),
    };
    const reason = !retrievalComplete
      ? `retrieval_incomplete: the search was not exhaustive (complete=${evidence.complete}, retrieval_truncated=${evidence.retrieval_truncated}, unavailable_channels=[${evidence.unavailable_channels.join(', ')}]); a truncated pool or failed channel does not prove the bank lacks the question — re-run search_bank (e.g. a narrower scope) before filing`
      : unsupported.length > 0
        ? `unsupported_constraint: ${unsupported.length} retrieval constraint(s) the dispatcher cannot honour (see receipt.unsupported_constraints)`
        : budgetExhausted
          ? `budget_exhausted: demand.control.max_budget_micro_usd=${demand.control.max_budget_micro_usd} — no paid supply may be dispatched on an exhausted budget; raise the budget and re-file under a NEW request_id`
          : deadlinePassed
            ? `deadline_passed: demand.control.needed_by=${demand.control.needed_by} is already in the past — no paid supply can arrive in time; extend the deadline and re-file under a NEW request_id`
            : 'supply_paused: paid supply outside placement is paused (SUPPLY_NIGHTLY_SPEND_CAP_USD=0)';
    return settleFiling({ status: 'held', reason, receipt });
  }

  // ── claim-first：先占位，再派发 ───────────────────────────────────────────
  // 两个同 request_id 并发调用只有一个能赢得 eventId 的 first-write-wins；输掉者回读
  // nonce 不等 → respondToStored，绝不 dispatch。此前两个并发调用都会抵达 dispatcher、
  // 可能重复入队付费 job（dispatcher 的 cooldown 查询不是原子占位）。
  const claimNonce = randomUUID();
  await writeEvent(ctx.db, {
    id: eventId,
    actor_kind: ctx.callerActor.kind,
    actor_ref: ctx.callerActor.ref,
    action: 'experimental:question_supply',
    subject_kind: 'query',
    subject_id: demand.demand_id,
    outcome: 'partial',
    session_id: ctx.sessionId ?? null,
    caused_by_event_id: ctx.causedByEventId ?? null,
    payload: {
      kind: 'bank_gap_filing',
      input_digest: input.input_digest,
      search_id: evidence.search_id,
      assessment_digest: evidence.assessment_digest,
      status: 'claimed',
      reason: 'claimed: dispatch pending; the receipt event carries the final outcome',
      demand_id: demand.demand_id,
      content_digest: digest,
      filing_nonce: claimNonce,
      receipt: {
        filing_event_id: eventId,
        content_digest: digest,
        retrieval_constraints: retrievalConstraints,
      },
    } satisfies StoredFilingPayload,
  });
  const canonical = await readStoredFiling(ctx.db, eventId);
  if (canonical === null) {
    throw new Error('file_bank_gap: claim row unreadable immediately after write');
  }
  if (canonical.filing_nonce !== claimNonce) {
    // 输掉并发占位：先到的可能是并发 claim、hold 终态或已完成的回执——一律不派发。
    const receiptRow =
      canonical.status === 'claimed' ? await readStoredFiling(ctx.db, receiptEventId) : null;
    return respondToStored(receiptRow ?? canonical);
  }

  // 只有 claim 赢家能抵达这里（需求控制已在上方 hold 关卡 enforcing）。
  // 生效约束（范围 KC + 范围 kind）随票进 job；7d 指纹 cooldown 与旧入口同一判据。
  const effectiveDemand = narrowDemandToSignedScope(demand, evidence);
  const target = buildBankGapTarget(effectiveDemand, evidence, input.request_id);
  const enqueued = await enqueueQuestionPreparerTicket(ctx.db, effectiveDemand, target, {
    sessionId: ctx.sessionId ?? null,
    filingEventId: eventId,
  });
  const queued = enqueued.status === 'dispatched';
  const dispatch =
    enqueued.status === 'dispatched'
      ? dispatchReceipt({
          status: 'dispatched',
          fingerprint: target.fingerprint,
          jobId: enqueued.job_id,
          stopCondition: `enqueued question_preparer_run (job ${enqueued.job_id}, ticket ${enqueued.event_id}); satisfied when ${target.desiredCount} usable question(s) meet the ticket's inventory goal`,
        })
      : dispatchReceipt({
          status: 'skipped',
          fingerprint: enqueued.fingerprint,
          jobId: null,
          stopCondition: enqueued.stop_condition,
        });
  const receipt: FileBankGapOutput['receipt'] = {
    filing_event_id: eventId,
    content_digest: digest,
    retrieval_constraints: retrievalConstraints,
    dispatch,
  };
  const reason =
    enqueued.status === 'dispatched'
      ? `dispatched to the question preparer (job ${enqueued.job_id}); satisfied when ${target.desiredCount} usable question(s) meet the ticket's inventory goal`
      : `skipped: ${enqueued.stop_condition}`;
  // 终态回执追加到独立事件 id（台账只增不改；claim 行保留为占位凭证）。本写入失败
  // 会抛出 → 该 request_id 停在 claimed_not_dispatched，重试绝不重派（见文件头注释）。
  await writeEvent(ctx.db, {
    id: receiptEventId,
    actor_kind: ctx.callerActor.kind,
    actor_ref: ctx.callerActor.ref,
    action: 'experimental:question_supply',
    subject_kind: 'query',
    subject_id: demand.demand_id,
    outcome: queued ? 'success' : 'partial',
    session_id: ctx.sessionId ?? null,
    caused_by_event_id: ctx.causedByEventId ?? null,
    payload: {
      kind: 'bank_gap_filing',
      input_digest: input.input_digest,
      search_id: evidence.search_id,
      assessment_digest: evidence.assessment_digest,
      status: queued ? 'filed' : 'held',
      reason,
      demand_id: demand.demand_id,
      content_digest: digest,
      filing_nonce: claimNonce,
      receipt,
    } satisfies StoredFilingPayload,
  });
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
    'File a supply demand using a v3 search_id, original demand statement and cited per-ref assessments. The server loads its own signed snapshot and rechecks actor, versions, serving state, scope and required/joint judgments; caller_assessed never becomes a database semantic fact. unknown, incomplete recall or unsupported supply filters are held, not evidence that the bank has no question. Pass request_id for idempotency and the full EvidenceDemandV1 controls/context. Same id+content replays; changed content is rejected. Budget, deadline, cooldown and transactional ticket/job lineage remain enforced before paid work. No raw search_evidence or model-authored MAC is accepted.',
  effect: 'write',
  inputSchema: FileBankGapInputSchema,
  outputSchema: FileBankGapOutputSchema,
  costClass: 'local',
  execute: executeFileBankGap,
  summarize: (_input, output) =>
    `bank gap ${output.demand_id} → ${output.status}${output.deduplicated ? ' (replay)' : ''}`,
  mirrorEvent: 'when_causal',
};
