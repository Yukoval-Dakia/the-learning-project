import type { SuggestionKindT } from '@/core/schema/event/known';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { ApiError } from '@/server/http/errors';
import { inArray } from 'drizzle-orm';
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
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export interface WriteNoteUpdateProposalInput extends CommonProducerInput {
  artifact_id: string;
  verification_event_id: string;
  summary_md: string;
  issues: unknown[];
}

export async function writeNoteUpdateProposal(
  db: DbLike,
  input: WriteNoteUpdateProposalInput,
): Promise<string> {
  return writeAiProposal(db, {
    id: input.id,
    actor_ref: 'note_verify',
    payload: {
      kind: 'note_update',
      target: { subject_kind: 'artifact', subject_id: input.artifact_id },
      reason_md: input.reason_md,
      evidence_refs: input.evidence_refs ?? [
        { kind: 'artifact', id: input.artifact_id },
        { kind: 'event', id: input.verification_event_id },
      ],
      proposed_change: {
        artifact_id: input.artifact_id,
        verification_event_id: input.verification_event_id,
        summary_md: input.summary_md,
        issues: input.issues,
      },
      rollback_plan: { action: 'write correction event against the note update proposal' },
      cooldown_key: `note_update:${input.artifact_id}`,
    },
    task_run_id: input.task_run_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

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
    actor_ref: 'learning_item_maintenance',
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
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export interface WriteRelearnProposalInput extends CommonProducerInput {
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
    actor_ref: 'learning_item_maintenance',
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
  // §1.C — the BlockAssembly candidate's 0..1 confidence (S4 passes it through).
  // DEFERRED persistence: the locked S1 `BlockMergeProposalChange` schema
  // (src/core/schema/proposal.ts) has no confidence field, so this is not stored
  // on the proposed_change today — Zod strips unknown keys on parse. It stays on
  // the producer's input contract for the S4 call site; inbox sort-by-confidence
  // is fork 4a (design §4), wired with the redraw UI slice, not in v1.
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
