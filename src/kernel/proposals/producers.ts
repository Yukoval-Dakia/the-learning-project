import { eq, inArray, sql } from 'drizzle-orm';
import {
  EvaluationProvenance,
  PublishedQuestionRevision,
  projectIssuedScoringBasis,
} from '@/core/schema/assessment';
import type { SuggestionKindT } from '@/core/schema/event/known';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { evaluation, evaluation_effective_head, event, question_revision } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { revisionRowToContract } from '@/kernel/records/assessment-issuance';
import { pendingProposalWithCooldown } from './inbox';
import { writeAiProposal } from './writer';

type DbLike = Db | Tx;

interface CommonProducerInput {
  id?: string;
  reason_md: string;
  evidence_refs?: ProposalEvidenceRefT[];
  caused_by_event_id?: string | null;
  task_run_id?: string | null;
  cost_usd?: number;
  created_at?: Date;
}

export interface WriteVariantQuestionProposalInput extends CommonProducerInput {
  source_question_id: string;
  source_attempt_event_id: string;
  prompt_md: string;
  reference_md: string;
  difficulty: number;
  knowledge_ids: string[];
  parent_variant_id: string;
  root_question_id: string;
  variant_depth: number;
}

export async function writeVariantQuestionProposal(
  db: DbLike,
  input: WriteVariantQuestionProposalInput,
): Promise<string> {
  return writeAiProposal(db, {
    id: input.id,
    actor_ref: 'variant_gen',
    payload: {
      kind: 'variant_question',
      target: { subject_kind: 'question', subject_id: input.source_question_id },
      reason_md: input.reason_md,
      evidence_refs: input.evidence_refs ?? [
        { kind: 'event', id: input.source_attempt_event_id },
        { kind: 'question', id: input.source_question_id },
      ],
      proposed_change: {
        source_question_id: input.source_question_id,
        source_attempt_event_id: input.source_attempt_event_id,
        prompt_md: input.prompt_md,
        reference_md: input.reference_md,
        difficulty: input.difficulty,
        knowledge_ids: input.knowledge_ids,
        parent_variant_id: input.parent_variant_id,
        root_question_id: input.root_question_id,
        variant_depth: input.variant_depth,
      },
      rollback_plan: { action: 'dismiss proposal; no question row has been materialized yet' },
      cooldown_key: `variant_question:${input.source_question_id}:${input.source_attempt_event_id}`,
      // P5.6 / YUK-178 (SK-3, the deterministic structural floor) — variant_question
      // is the ONLY always-corrective proposal kind: this producer fires ONLY after
      // a failed attempt (it requires source_attempt_event_id + source_question_id),
      // so its proposals are by construction failure-retries. Hard-set corrective so
      // accepts here never inflate the P5.4-L2 accept-learned KPI (§5.1 gate).
      suggestion_kind: 'corrective',
    },
    task_run_id: input.task_run_id ?? null,
    caused_by_event_id: input.caused_by_event_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

// YUK-358 决定7 (ADR-0040) — writeNoteUpdateProposal (the patch-less
// note_verify→inbox producer) was DELETED. It wrote a `note_update` proposal
// carrying only a summary + issues (no NotePatch), so the owner could never act
// on it (the accept owner acceptNoteUpdateProposal applies a patch that this
// producer never supplied). note_verify's needs_review verdict is now advisory
// (verification_summary + the experimental:note_verify event), and acting on the
// issues is a flag-gated verify→refine enqueue that routes through the NORMAL
// refine gate. The `note_update` proposal KIND survives — it is still produced
// (with a patch) by writeNoteRefineProposal and accepted by acceptNoteUpdateProposal.

export interface WriteLearningItemProposalInput extends CommonProducerInput {
  topic: string;
  plan_case?: string;
  knowledge_node: unknown;
  proposed_knowledge?: unknown;
  hub: unknown;
  atomics: unknown[];
  longs?: unknown[];
  legacy_subject_id?: string;
  legacy_event_payload?: Record<string, unknown>;
}

export async function writeLearningItemProposal(
  db: DbLike,
  input: WriteLearningItemProposalInput,
): Promise<string> {
  const proposedChange = {
    topic: input.topic,
    ...(input.plan_case ? { plan_case: input.plan_case } : {}),
    knowledge_node: input.knowledge_node,
    ...(input.proposed_knowledge ? { proposed_knowledge: input.proposed_knowledge } : {}),
    hub: input.hub,
    atomics: input.atomics,
    longs: input.longs ?? [],
  };

  return writeAiProposal(db, {
    id: input.id,
    actor_ref: 'learning_intent',
    payload: {
      kind: 'learning_item',
      target: { subject_kind: 'learning_item', subject_id: null },
      reason_md: input.reason_md,
      evidence_refs: input.evidence_refs ?? [],
      proposed_change: proposedChange,
      rollback_plan: { action: 'dismiss proposal; no learning_item rows materialized yet' },
      cooldown_key: `learning_item:intent:${input.topic}`,
    },
    event_override: input.legacy_event_payload
      ? {
          action: 'experimental:propose_learning_intent',
          subject_kind: 'artifact',
          subject_id: input.legacy_subject_id,
          payload: input.legacy_event_payload,
        }
      : undefined,
    task_run_id: input.task_run_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export interface WriteCompletionProposalInput extends CommonProducerInput {
  // YUK-270 — defaults to 'learning_item_maintenance' (the autonomous maintenance
  // pass). Conversational callers (Copilot's propose_learning_item_completion)
  // pass their callerActor.ref so conversation audit/replay/inbox attribution
  // record the real triggering actor, not the maintenance batch.
  actor_ref?: string;
  learning_item_id: string;
  triggering_signals: string[];
  evidence_json?: Record<string, unknown>;
}

export async function writeCompletionProposal(
  db: DbLike,
  input: WriteCompletionProposalInput,
): Promise<string> {
  return writeAiProposal(db, {
    id: input.id,
    actor_ref: input.actor_ref ?? 'learning_item_maintenance',
    payload: {
      kind: 'completion',
      target: { subject_kind: 'learning_item', subject_id: input.learning_item_id },
      reason_md: input.reason_md,
      evidence_refs: input.evidence_refs ?? [],
      proposed_change: {
        learning_item_id: input.learning_item_id,
        triggering_signals: input.triggering_signals,
        evidence_json: input.evidence_json ?? {},
      },
      rollback_plan: { action: 'write correction event and clear ai_propose completion evidence' },
      cooldown_key: `completion:${input.learning_item_id}`,
    },
    task_run_id: input.task_run_id ?? null,
    caused_by_event_id: input.caused_by_event_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export interface WriteRelearnProposalInput extends CommonProducerInput {
  // YUK-270 — defaults to 'learning_item_maintenance' (the autonomous maintenance
  // pass). Conversational callers (Copilot's propose_learning_item_relearn) pass
  // their callerActor.ref so conversation audit/replay/inbox attribution record the
  // real triggering actor, not the maintenance batch.
  actor_ref?: string;
  learning_item_id: string;
  current_mastery: number;
  peak_mastery: number;
  days_since_done: number;
}

export async function writeRelearnProposal(
  db: DbLike,
  input: WriteRelearnProposalInput,
): Promise<string> {
  return writeAiProposal(db, {
    id: input.id,
    actor_ref: input.actor_ref ?? 'learning_item_maintenance',
    payload: {
      kind: 'relearn',
      target: { subject_kind: 'learning_item', subject_id: input.learning_item_id },
      reason_md: input.reason_md,
      evidence_refs: input.evidence_refs ?? [],
      proposed_change: {
        learning_item_id: input.learning_item_id,
        current_mastery: input.current_mastery,
        peak_mastery: input.peak_mastery,
        days_since_done: input.days_since_done,
      },
      rollback_plan: { action: 'dismiss proposal and keep item in resting state' },
      cooldown_key: `relearn:${input.learning_item_id}`,
    },
    task_run_id: input.task_run_id ?? null,
    caused_by_event_id: input.caused_by_event_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export interface WriteDeferProposalInput extends CommonProducerInput {
  actor_ref?: string;
  learning_item_id: string;
  defer_until?: string;
  reason?: string;
}

/**
 * Wave 5 / T-D6/C — Coach-driven `defer` plan adjustment.
 * Writes a `defer` proposal so the user can review and apply (or dismiss)
 * a request to postpone a LearningItem. No direct mutation; accept owner
 * routes own the transition.
 */
export async function writeDeferProposal(
  db: DbLike,
  input: WriteDeferProposalInput,
): Promise<string> {
  return writeAiProposal(db, {
    id: input.id,
    actor_ref: input.actor_ref ?? 'coach',
    payload: {
      kind: 'defer',
      target: { subject_kind: 'learning_item', subject_id: input.learning_item_id },
      reason_md: input.reason_md,
      evidence_refs: input.evidence_refs ?? [],
      proposed_change: {
        learning_item_id: input.learning_item_id,
        ...(input.defer_until ? { defer_until: input.defer_until } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
      rollback_plan: { action: 'dismiss proposal; learning_item remains active' },
      cooldown_key: `defer:${input.learning_item_id}`,
    },
    task_run_id: input.task_run_id ?? null,
    caused_by_event_id: input.caused_by_event_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export interface WriteArchiveProposalInput extends CommonProducerInput {
  actor_ref?: string;
  target_subject_kind: string;
  target_subject_id: string;
  proposed_change: Record<string, unknown>;
  // P5.6 / YUK-178 — OPTIONAL proactive/corrective discriminator. archive is
  // audited always-proactive (§3.1); this exists only so the
  // propose_knowledge_mutation tool's model-labeled arg can flow through the
  // archive branch of writeKnowledgeProposeEvent. Absent → proactive (ND-SK-1).
  suggestion_kind?: SuggestionKindT;
  legacy_event_override?: {
    action: string;
    subject_kind: string;
    subject_id: string;
    payload: Record<string, unknown>;
  };
}

export async function writeArchiveProposal(
  db: DbLike,
  input: WriteArchiveProposalInput,
): Promise<string> {
  return writeAiProposal(db, {
    id: input.id,
    actor_ref: input.actor_ref ?? 'maintenance',
    payload: {
      kind: 'archive',
      target: { subject_kind: input.target_subject_kind, subject_id: input.target_subject_id },
      reason_md: input.reason_md,
      evidence_refs: input.evidence_refs ?? [],
      proposed_change: {
        subject_kind: input.target_subject_kind,
        subject_id: input.target_subject_id,
        ...input.proposed_change,
      },
      rollback_plan: { action: 'restore archived entity through correction/revive flow' },
      cooldown_key: `archive:${input.target_subject_kind}:${input.target_subject_id}`,
      // P5.6 / YUK-178 — pass through the model-labeled discriminator; absent →
      // proactive (so non-tool archive callers keep absence === proactive).
      ...(input.suggestion_kind ? { suggestion_kind: input.suggestion_kind } : {}),
    },
    event_override: input.legacy_event_override,
    task_run_id: input.task_run_id ?? null,
    caused_by_event_id: input.caused_by_event_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

// YUK-202 / BlockAssembly path-B (design 2026-06-02 §1.C + §5) — AI proposes
// cross-page/adjacent block merges; the user accepts in the inbox (S2's
// acceptBlockMergeProposal reuses the YUK-195 `mergeQuestions` primitive). This
// producer ONLY writes the proposal event — no auto-merge (hard safety boundary,
// §5). `continuity_signal` is the semantic-only cue (§0: spatial/bbox page-edge
// detection is DEFERRED to slice 2b — block_assembly gains a spatial input later
// with no rework here), optional so low-signal candidates can still propose.
export interface WriteBlockMergeProposalInput extends CommonProducerInput {
  ingestion_session_id: string;
  primary_block_id: string;
  merge_block_ids: string[];
  // §1.C / fork 4a — the BlockAssembly candidate's 0..1 confidence (S4 passes it
  // through). Persisted on proposed_change.confidence so the redraw inbox (YUK-169)
  // can sort/colour by it; the model's confidence is not recoverable after the run.
  confidence: number;
  continuity_signal: 'page_edge' | 'numbering' | 'stem_answer_split' | 'carryover';
}

export async function writeBlockMergeProposal(
  db: DbLike,
  input: WriteBlockMergeProposalInput,
): Promise<string> {
  return writeAiProposal(db, {
    id: input.id,
    actor_ref: 'block_assembly',
    payload: {
      kind: 'block_merge',
      target: { subject_kind: 'question_block', subject_id: input.primary_block_id },
      reason_md: input.reason_md,
      // §1.C — each block (primary + merge candidates) is an evidence ref so the
      // inbox preview can resolve every block; match the sibling EvidenceRef shape.
      evidence_refs: input.evidence_refs ?? [
        { kind: 'question', id: input.primary_block_id },
        ...input.merge_block_ids.map((id) => ({ kind: 'question' as const, id })),
      ],
      proposed_change: {
        primary_block_id: input.primary_block_id,
        merge_block_ids: input.merge_block_ids,
        ingestion_session_id: input.ingestion_session_id,
        continuity_signal: input.continuity_signal,
        // YUK-202 fork 4a — persist the AI's confidence so the redraw inbox can
        // sort/colour by it; not recoverable after the run.
        confidence: input.confidence,
      },
      rollback_plan: {
        action:
          'dismiss proposal; no blocks merged yet (accept reuses mergeQuestions, which is lossy — no real unmerge, §7)',
      },
      // §5 dedup (1) — sort the merge ids so the same block set produces a stable
      // cooldown_key regardless of candidate ordering. This is a stable dedup KEY
      // for downstream inbox cooldown-signal folding, NOT a pre-write suppressor:
      // writeAiProposal does not hard-suppress a second write, so a re-run of the
      // auto_enroll pass on the same session can write a duplicate proposal. That is
      // acceptable — accept-side existingAcceptRate idempotency + mergeQuestions
      // draft-only soft-reject prevent any double-merge (§5 dedup (2)).
      cooldown_key: `block_merge:${input.ingestion_session_id}:${input.primary_block_id}:${[...input.merge_block_ids].sort().join(',')}`,
      // suggestion_kind intentionally OMITTED → resolveSuggestionKind defaults to
      // 'proactive'. block_merge is a proactive structural suggestion over draft
      // blocks, NOT a failure-retry: variant_question is the ONLY corrective kind
      // (SK-3). Tagging it 'corrective' would make signals.ts early-return on accept
      // and silently drop the proposal_signals row / accept_count / cooldown clear.
    },
    caused_by_event_id: input.caused_by_event_id ?? null,
    task_run_id: input.task_run_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export interface WriteJudgeRetractionProposalInput extends CommonProducerInput {
  judge_event_id: string;
  appeal_event_id?: string;
}

async function assertJudgeRetractionEvidenceRefs(
  db: DbLike,
  evidenceRefs: ProposalEvidenceRefT[],
): Promise<void> {
  const eventRefs = evidenceRefs.filter((ref) => ref.kind === 'event');
  if (eventRefs.length !== evidenceRefs.length) {
    throw new ApiError(
      'evidence_ref_must_be_judge_event',
      'judge_retraction evidence_refs must all point to judge events',
      422,
    );
  }
  const ids = [...new Set(eventRefs.map((ref) => ref.id))];
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ id: event.id, action: event.action })
          .from(event)
          .where(inArray(event.id, ids));
  const judgeIds = new Set(rows.filter((row) => row.action === 'judge').map((row) => row.id));
  const invalid = ids.filter((id) => !judgeIds.has(id));
  if (invalid.length > 0) {
    throw new ApiError(
      'evidence_ref_must_be_judge_event',
      `judge_retraction evidence_refs must point to judge events: ${invalid.join(', ')}`,
      422,
    );
  }
}

/**
 * @deprecated M2 (YUK-316, D15)：appeal 不再产 judge_retraction proposal——申诉
 * 直接走异步 rejudge job（correction 留痕、结果直接生效）。本函数已无生产调用方；
 * kind/schema/applier 随 M4 提议生命周期契约整体清理（历史 proposal 行仍引用该 kind，
 * 读路径在那之前保留）。
 */
export async function writeJudgeRetractionProposal(
  db: DbLike,
  input: WriteJudgeRetractionProposalInput,
): Promise<string> {
  const evidence_refs = input.evidence_refs ?? [
    { kind: 'event' as const, id: input.judge_event_id },
  ];
  await assertJudgeRetractionEvidenceRefs(db, evidence_refs);

  return writeAiProposal(db, {
    id: input.id,
    actor_ref: 'appeal',
    payload: {
      kind: 'judge_retraction',
      target: { subject_kind: 'event', subject_id: input.judge_event_id },
      reason_md: input.reason_md,
      evidence_refs,
      proposed_change: {
        judge_event_id: input.judge_event_id,
        ...(input.appeal_event_id ? { appeal_event_id: input.appeal_event_id } : {}),
        correction_kind: 'retract',
        reason_md: input.reason_md,
      },
      rollback_plan: { action: 'dismiss proposal; target judge remains active' },
      cooldown_key: `judge_retraction:${input.judge_event_id}`,
    },
    task_run_id: input.task_run_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export interface WriteEvaluationCorrectionProposalInput extends CommonProducerInput {
  actor_ref?: string;
  /** 目标 evaluation 行（native 评估，非 legacy judge event）。 */
  evaluation_id: string;
  /** rejudge = 重评冻结输入走 appeal 链；assert = 人工判定的 unit 结果直接激活。 */
  correction_kind?: 'rejudge' | 'assert';
  /** correction_kind='assert' 时必填：每个在判 unit 一条人工判定。 */
  asserted_verdicts?: { scoring_unit_id: string; verdict: 'correct' | 'incorrect' }[];
  /** 争议判词快照（coarse_outcome / score / judged_by 等）——提案的 grounding 证据。 */
  observed?: Record<string, unknown>;
  /** frozen 提交的 attempt event id（evt_assessment_<submission_id>），作 evidence_ref。 */
  attempt_event_id?: string | null;
}

export type WriteEvaluationCorrectionProposalResult =
  | { status: 'filed'; proposal_event_id: string }
  | { status: 'duplicate'; proposal_event_id: null };

// assert 提案在落单时就按冻结发题范围校验全覆盖：等 accept 才发现缺 unit
// 会留下一条永远无法生效的提案。校验口径与 accept 的 manual_assert 相同。
async function assertCorrectionCoversFrozenScope(
  db: DbLike,
  evaluationProvenance: unknown,
  assertedVerdicts: { scoring_unit_id: string; verdict: 'correct' | 'incorrect' }[],
): Promise<void> {
  const provenance = EvaluationProvenance.safeParse(evaluationProvenance);
  if (!provenance.success || !provenance.data.input_snapshot) {
    throw new ApiError(
      'frozen_input_unavailable',
      'assert correction requires the frozen input snapshot',
      422,
    );
  }
  const [revisionRow] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, provenance.data.input_snapshot.revision_id))
    .limit(1);
  if (!revisionRow) {
    throw new ApiError(
      'frozen_input_unavailable',
      'frozen revision row missing for assert correction',
      422,
    );
  }
  const revision = PublishedQuestionRevision.parse(revisionRowToContract(revisionRow));
  const scopedBasis = projectIssuedScoringBasis(
    revision,
    provenance.data.input_snapshot.issued_part_ids,
  );
  const verdictByUnit = new Map(
    assertedVerdicts.map((verdict) => [verdict.scoring_unit_id, verdict.verdict]),
  );
  const scopedUnitIds = new Set(scopedBasis.units.map((unit) => unit.scoring_unit_id));
  const missing = [...scopedUnitIds].filter((unitId) => !verdictByUnit.has(unitId));
  if (missing.length > 0) {
    throw new ApiError(
      'assert_coverage_incomplete',
      `asserted_verdicts must cover every in-scope unit; missing '${missing.join("', '")}'`,
      422,
    );
  }
  const unknown = [...verdictByUnit.keys()].filter((unitId) => !scopedUnitIds.has(unitId));
  if (unknown.length > 0) {
    throw new ApiError(
      'assert_unit_unknown',
      `asserted_verdicts references unknown/out-of-scope unit '${unknown.join("', '")}'`,
      422,
    );
  }
  const notAdditive = scopedBasis.units
    .filter((unit) => unit.points === null)
    .map((unit) => unit.scoring_unit_id);
  if (notAdditive.length > 0) {
    throw new ApiError(
      'assert_unit_not_additive',
      `unit '${notAdditive.join("', '")}' is not additive-scored — manual assert needs the holistic lane`,
      422,
    );
  }
}

/**
 * YUK-1407 — agent 发现疑似误判 ⇒ 可逆纠错 proposal（不自动执行）。
 *
 * grounding 纪律：目标必须是真实存在的 completed evaluation；proposal 携带该
 * 评价的判词快照（observed）与 attempt event 证据引用 —— 不是 note 文本里
 * 的裸 regex。pending 的 evaluation attempt 是可重试 infra 态，不是可纠错的
 * 判词 → 422。
 *
 * 同一 evaluation 的 pending 纠错提案在事务内原子去重：先取 cooldown 咨询锁再
 * 复查 pending 集，避免两个并发 producer 都看不到对方而各落一单，后续各跑一次
 * 同一冻结输入的付费重判。
 *
 * accept 语义（practice proposal-accept-applier）：
 *   - rejudge → 写 `experimental:appeal_request`（expected head = 本提案创建
 *     时快照，transport 到 activation CAS —— head 已动则冲突，不静默重订）
 *     入既有异步重判链（rejudge job → 冻结输入重评 → activation CAS →
 *     settlement replay 回算学习效应）；
 *   - assert  → 以 asserted_verdicts 同步产出 manual_assert candidate 并激活。
 * 两条路径都不回写原评价；纠正本身也可再由新 proposal 纠回。
 */
export async function writeEvaluationCorrectionProposal(
  db: DbLike,
  input: WriteEvaluationCorrectionProposalInput,
): Promise<WriteEvaluationCorrectionProposalResult> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        evaluation_id: evaluation.evaluation_id,
        status: evaluation.status,
        evaluation_group_id: evaluation.evaluation_group_id,
        submission_id: evaluation.submission_id,
        provenance: evaluation.provenance,
      })
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, input.evaluation_id))
      .limit(1);
    if (!target) {
      throw new ApiError('not_found', `evaluation ${input.evaluation_id} not found`, 404);
    }
    if (target.status !== 'completed') {
      throw new ApiError(
        'not_correctable',
        'a pending evaluation attempt is retryable infra state, not a correctable verdict',
        422,
      );
    }
    const correctionKind = input.correction_kind ?? 'rejudge';
    if (
      correctionKind === 'assert' &&
      (!Array.isArray(input.asserted_verdicts) || input.asserted_verdicts.length === 0)
    ) {
      throw new ApiError(
        'validation_error',
        "correction_kind='assert' requires non-empty asserted_verdicts",
        400,
      );
    }
    const cooldownKey = `judge_retraction:${input.evaluation_id}`;
    // 事务级咨询锁让「查 pending → 写 proposal」成为原子操作：只压缩并发重复
    // 落单，不替代 accept 的冻结 head/CAS 校验。
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('proposal-cooldown'), hashtext(${cooldownKey}))`,
    );
    if (await pendingProposalWithCooldown(tx, 'judge_retraction', cooldownKey)) {
      return { status: 'duplicate' as const, proposal_event_id: null };
    }
    if (correctionKind === 'assert') {
      await assertCorrectionCoversFrozenScope(tx, target.provenance, input.asserted_verdicts ?? []);
    }
    // P1 review — head 快照在组锁下、与 proposal 写入同事务内读取：accept 时
    // 把该冻结期望运进 correction request 与 activation CAS —— head 已移动
    // ⇒ 拒绝/冲突，绝不把过期 proposal 静默 rebase 到新 head。服务端派生，
    // 不可由 agent 提供。null/0 = 组无 head（全未决评价也可被纠错）。
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${target.evaluation_group_id}))`,
    );
    const [head] = await tx
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, target.evaluation_group_id))
      .limit(1);
    const expectedHead = {
      effective_evaluation_id: head?.effective_evaluation_id ?? null,
      generation: head?.generation ?? 0,
    };
    const evidenceRefs: ProposalEvidenceRefT[] = [...(input.evidence_refs ?? [])];
    if (input.attempt_event_id && !evidenceRefs.some((ref) => ref.id === input.attempt_event_id)) {
      evidenceRefs.unshift({ kind: 'event', id: input.attempt_event_id });
    }

    const proposalEventId = await writeAiProposal(tx, {
      id: input.id,
      actor_ref: input.actor_ref ?? 'copilot',
      payload: {
        kind: 'judge_retraction',
        target: { subject_kind: 'evaluation', subject_id: input.evaluation_id },
        reason_md: input.reason_md,
        evidence_refs: evidenceRefs,
        suggestion_kind: 'corrective',
        proposed_change: {
          evaluation_id: input.evaluation_id,
          evaluation_group_id: target.evaluation_group_id,
          submission_id: target.submission_id,
          correction_kind: correctionKind,
          expected_effective_id: expectedHead.effective_evaluation_id,
          expected_generation: expectedHead.generation,
          ...(input.asserted_verdicts ? { asserted_verdicts: input.asserted_verdicts } : {}),
          observed: input.observed ?? {},
          reason_md: input.reason_md,
        },
        rollback_plan: {
          action:
            'dismiss proposal — no evaluation changes; an accepted correction is itself a new evaluation/correction event and can be re-corrected by a further proposal',
        },
        cooldown_key: cooldownKey,
      },
      task_run_id: input.task_run_id ?? null,
      cost_usd: input.cost_usd,
      created_at: input.created_at,
    });
    return { status: 'filed' as const, proposal_event_id: proposalEventId };
  });
}
