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

export interface WriteArchiveProposalInput extends CommonProducerInput {
  actor_ref?: string;
  target_subject_kind: string;
  target_subject_id: string;
  proposed_change: Record<string, unknown>;
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
    },
    event_override: input.legacy_event_override,
    task_run_id: input.task_run_id ?? null,
    caused_by_event_id: input.caused_by_event_id ?? null,
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
