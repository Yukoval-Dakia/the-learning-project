// YUK-1448 (Stage 1 batch D / 统一问题定级设计 §7+§9) — `file_bank_gap` DomainTool
// (effect:'write')。search_bank 检索不足（verdict sparse/none）时落缺口供题需求：
//
//   1. 检索证据防伪：search_evidence 必须携带 search_bank 服务端签发的
//      evidence_mac（BANK_GAP_EVIDENCE_SECRET keyed HMAC-SHA256，覆盖除
//      evidence_mac 外全部 gap 字段的 canonical JSON）。缺失或不符 → rejected /
//      evidence_not_from_search_bank——调用方伪造 complete=true 也触发不了付费
//      dispatch。secret 未配置时 filing 整体 fail closed。
//   2. 幂等登记 + claim-first 派发：request_id 派生确定性事件 id。派发付费 job
//      前先写 'claimed' 占位行（与 dispatcher 同一 experimental:question_supply
//      action，状态恒为 'claimed'/'filed'/'held'——绝不写 'dispatched'，不污染
//      dispatcher 的 7d cooldown 凭证）。writeEvent first-write-wins，
//      filing_nonce 回读相等者独占派发权；输掉并发的调用走重放/拒绝，绝不
//      dispatch。派发结果追加到 `fbgap|<request_id>|receipt` 回执事件（台账只增
//      不改）。同 request_id + 同内容 → 重放已存回执（deduplicated=true）；同 id
//      + 不同内容 → 显式 rejected。
//   3. retrieval_constraints（within_refs / source / kind / difficulty / KC，含
//      subject / exclude_refs / similar_to）随需求一并存档——缺口上下文完整可追溯。
//   4. 检索不完整（池截断 / 通道不可用）→ held/retrieval_incomplete：只证明没搜全，
//      不能立成「全库不存在」。
//   5. 需求控制先于派发 enforcing：max_budget_micro_usd <= 0 → held/
//      budget_exhausted；needed_by 已过期 → held/deadline_passed。零预算/过期
//      需求绝不触发付费 job。
//   6. 调用既有 dispatcher（dispatchSupplyTarget）。dispatcher 无法落实的限制 →
//      held/unsupported_constraint，绝不静默丢字段后假装已供题。
//
// 已知限制（claim-first 的诚实形态）：winner 在 claim 落账后、receipt 落账前崩溃
// 时，该 request_id 永久停在 claimed_not_dispatched——同内容重试只重放 held 回执、
// 绝不再派发（付费 job 可能已入队也可能没有，两者无法区分，fail closed）。须由
// operator 人工对账（查 dispatcher cooldown 台账里该 target fingerprint 是否真派过
// / job 队列），确认未派后用新 request_id 重新落需求。
//
// 硬边界：不碰 learner state；不做教学决策；本工具自身零 LLM 调用（付费发生在
// 派出的 sourcing_web / quiz_gen job 内，受 dispatcher 指纹 cooldown 节流）。

import { createHash, randomUUID } from 'node:crypto';
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
import {
  BankGapRequestSchema,
  type BankSearchScope,
  verifyBankGapEvidenceMac,
} from './bank-search';

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

/** scope.kind 落到 dispatcher 的题型：必须是该 kind 的某个持久化形态，且在
 * demand.task.kinds 内（'any' 时取 scope.kind 本身的形态）。null = 无法落实。 */
function scopeTargetKind(scopeKind: string, demandKinds: string[]): string | null {
  const forms = canonicalKindToPersistedForms(scopeKind);
  if (demandKinds.includes('any'))
    return forms.includes(scopeKind) ? scopeKind : (forms[0] ?? null);
  return demandKinds.find((kind) => forms.includes(kind)) ?? null;
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
    if (scope.knowledge_mode === 'all' && new Set(scope.knowledge_ids).size > 1) {
      unsupported.push(
        "knowledge: mode 'all' needs every KC on one question; supply routes anchor on a single KC and cannot guarantee co-coverage",
      );
    }
  }
  if (scope.kind !== undefined && scopeTargetKind(scope.kind, demand.task.kinds) === null) {
    unsupported.push(
      `kind: no persisted form of search kind '${scope.kind}' is within demand.task.kinds [${demand.task.kinds.join(', ')}]`,
    );
  }
  return unsupported;
}

// ── 需求 → 供给目标（dispatcher 输入）──────────────────────────────────────

function buildBankGapTarget(
  demand: EvidenceDemandV1T,
  evidence: z.infer<typeof BankGapRequestSchema>,
  requestId: string,
): QuestionSupplyTarget {
  const scope = evidence.constraints.scope;
  const [firstKind] = demand.task.kinds;
  // scope.kind 已由 checkHonourableConstraints 验证可落实；作为硬题型约束派出。
  const scopeKind =
    scope.kind !== undefined ? scopeTargetKind(scope.kind, demand.task.kinds) : null;
  const kind =
    scopeKind ?? (demand.task.kinds.length === 1 && firstKind !== undefined ? firstKind : 'any');
  // 检索 KC 集合原样派出（mode 'all' 多 KC 已 held）；mode 'any' 时路由锚定集合中
  // 首个 KC，产出的题仍落在该集合内。
  const knowledgeIds =
    scope.knowledge_ids !== undefined
      ? [...new Set(scope.knowledge_ids)]
      : demand.claim.knowledge_ids;
  // eligible_count 是库存目标；requested_count 是本次检索的期望量——取较大者，
  // 并夹到 [1,10]（executor/quiz_gen 载荷的 count 上限）。
  const desiredCount = Math.min(
    10,
    Math.max(1, demand.inventory_goal.eligible_count, evidence.constraints.requested_count),
  );
  return {
    id: `bankgap:${demand.demand_id}`,
    fingerprint: targetFingerprint({
      subjectId: demand.subject_id,
      knowledgeIds,
      kind,
      difficultyBand: demand.difficulty.band as DifficultyBand,
      gapKind: 'frontier_zero',
      minSourceTier: 2,
    }),
    gapKind: 'frontier_zero',
    subjectId: demand.subject_id,
    knowledgeIds,
    kind,
    difficultyBand: demand.difficulty.band as DifficultyBand,
    desiredCount,
    // bank gap = 找既有题失败的缺口：先 web 找现成题（tier 2），退而闭卷生成。
    minSourceTier: 2,
    routePreference: ['sourcing_web', 'quiz_gen'],
    priority: 50,
    reason: `bank search gap filed via file_bank_gap (request_id=${requestId}); query="${evidence.constraints.query}"; retrieved ${evidence.constraints.retrieved_count}/${evidence.constraints.requested_count}`,
    constraints: scopeKind !== null ? { kindRequired: true } : {},
    context: evidenceDemandToTargetContext(demand),
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

interface StoredFilingPayload {
  kind: 'bank_gap_filing';
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
        'evidence_not_from_search_bank: search_evidence lacks a valid server-minted evidence_mac — pass coverage.gap_request from search_bank verbatim (fabricated evidence, e.g. a hand-written complete:true, can never trigger paid dispatch)',
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
      caused_by_event_id: ctx.causedByEventId ?? null,
      payload: {
        kind: 'bank_gap_filing',
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

  const unsupported = checkHonourableConstraints(scope, demand);
  const retrievalComplete = evidence.complete && evidence.unavailable_channels.length === 0;
  // 需求控制先于任何派发：零/负预算或已过期的需求绝不触发付费 job。
  const budgetExhausted = demand.control.max_budget_micro_usd <= 0;
  const deadlinePassed =
    demand.control.needed_by !== null && Date.parse(demand.control.needed_by) <= Date.now();
  if (!retrievalComplete || unsupported.length > 0 || budgetExhausted || deadlinePassed) {
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
          : `deadline_passed: demand.control.needed_by=${demand.control.needed_by} is already in the past — no paid supply can arrive in time; extend the deadline and re-file under a NEW request_id`;
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
    caused_by_event_id: ctx.causedByEventId ?? null,
    payload: {
      kind: 'bank_gap_filing',
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

  // 只有 claim 赢家能抵达这里（需求控制已在上方 hold 关卡 enforcing），直接派发。
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
    caused_by_event_id: ctx.causedByEventId ?? null,
    payload: {
      kind: 'bank_gap_filing',
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
    "File a question-supply demand for a bank search gap (search_bank coverage.verdict sparse/none). Input: request_id (your idempotency key), the full EvidenceDemandV1 (search_bank's gap_request is only a seed — you must add demand_id/policy_version/subject_id/claim/evidence/task/difficulty/inventory_goal.horizon_days/control), and the search evidence — the gap_request object VERBATIM, including its server-minted evidence_mac (a missing or mismatched MAC is rejected as evidence_not_from_search_bank; fabricated evidence can never trigger paid dispatch). Idempotent: same request_id + same content replays the stored receipt; same request_id + different content is rejected. Demand controls are enforced BEFORE any dispatch: max_budget_micro_usd<=0 is held as budget_exhausted and an already-past needed_by is held as deadline_passed. The demand plus its retrieval constraints (within_refs/source/kind/difficulty/KC) are ledgered, then the existing supply dispatcher is called with the search kind and KC set as hard constraints. Dispatch is claim-first: a 'claimed' ledger row (first-write-wins) is written BEFORE any paid job is enqueued, so concurrent same-request_id calls can never double-dispatch — only the claim winner dispatches, and its outcome is appended as a separate receipt event. If the search was incomplete (gap_request.complete=false or a channel unavailable) the result is held/retrieval_incomplete — an incomplete search never proves the bank lacks the question. If the dispatcher cannot honour a constraint (including a subject that differs from demand.subject_id, or knowledge_mode 'all' over several KCs) the result is held/unsupported_constraint — fields are never silently dropped. If an earlier call claimed the request_id but left no receipt (crash between claim and dispatch), the result is held/claimed_not_dispatched and never redispatches — reconcile manually and re-file under a NEW request_id only if no job went out. Output: demand_id, deduplicated, queued|held|rejected, reason, business receipt (ledger event id + dispatch outcome).",
  effect: 'write',
  inputSchema: FileBankGapInputSchema,
  outputSchema: FileBankGapOutputSchema,
  costClass: 'local',
  execute: executeFileBankGap,
  summarize: (_input, output) =>
    `bank gap ${output.demand_id} → ${output.status}${output.deduplicated ? ' (replay)' : ''}`,
  mirrorEvent: 'when_causal',
};
