// Activation only. Scoring and model calls finish before this, outside the lock.
// Lock order: learning-state G, the group advisory lock, then FOR UPDATE on the
// candidate, the submission, the effective head, and the question group root.
// Every learning writer takes G first, so this order has no cycle.
// Publish and verify take that same group-root lock, so admission writes and
// activation reads cannot interleave.
// Suspended, withdrawn, or a missing lifecycle is stale. An automatic score needs
// the server-sealed admission snapshot: same revision, admitted, same generation, no hold.
// A missing snapshot is stale_admission. The request generation cannot invent one.
// Manual and self-report ratings skip rule admission and still obey hold and withdrawn.
// The injected port writes learning state on this transaction. It must not call a model
// or open another transaction. With no port, activation throws and the caller
// transaction rolls back. No head move, no receipt.
// applied, ineligible, and failed_pending each leave a receipt event. There is no receipt table.
// Attempts that never ran do not. The CAS predicate is the database backstop after the in-lock check.
// The in-lock check is resolveActivationCas in core/schema/assessment/ids.ts.
// The receipt event is the outbox. Generation moves by one. Both expected ids are required.
// coordinate_mismatch means the submission, issuance, revision, and frozen input do not name one group.
// Content digest, what a score means, and whether a regrade is extra practice stay inside the port.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  evaluationMemberFromRows,
  freezeEvaluationInput,
  matchesEvaluationInput,
  sameMemberSet,
} from '@/core/assessment-input';
import { GroupInputContractError } from '@/core/schema/assessment/group-input';
import type {
  EvaluationGroupIdT,
  EvaluationIdT,
  IssuanceIdT,
  RevisionIdT,
  SubmissionIdT,
} from '@/core/schema/assessment/ids';
import { ActivateEvaluationIntent, resolveActivationCas } from '@/core/schema/assessment/ids';
import { EvaluationProvenance, type EvaluationRecordT } from '@/core/schema/assessment/judgment';
import { FsrsRating } from '@/core/schema/business';
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  evaluation_group,
  event,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';

export const ASSESSMENT_ACTIVATION_ACTION = 'experimental:assessment_activation';
export const ASSESSMENT_ACTIVATION_VERSION = 1 as const;

/**
 * applied wrote learning state here. ineligible still advances the head and says so.
 * failed_pending advances the head too. The receipt stays for replay. Do not drop it.
 */
export type ActivationEffect = 'applied' | 'ineligible' | 'failed_pending';

export interface ActivationSettleInput {
  tx: Tx;
  /** Read under the row locks. The port must not re-read a newer row. */
  evaluation: typeof evaluation.$inferSelect;
  submission: typeof assessment_submission.$inferSelect;
  head: typeof evaluation_effective_head.$inferSelect;
  issuance: typeof assessment_issuance.$inferSelect;
  /** Group root. Admission is read on this row's lock. */
  questionGroupId: string;
  /** Validated complete input scope; legacy single-member fixtures retain their issuance. */
  inputScope?: {
    issued_part_ids: string[];
    occurrence_at: string;
    member_submission_ids: string[];
  };
  /** Explicit scheduling choice; never alters the candidate's grading evidence. */
  userRating?: z.infer<typeof FsrsRating>;
  /** Server-observed receipt: reactivating an old candidate is not new practice. */
  reusesActivation?: boolean;
  /** Immutable attempt capture, read by settlement rather than inferred from activation time. */
  forgettingCapture?: {
    hints_used: number | null;
    final_hint_level: number | null;
    self_confidence: number | null;
    latency_ms: number | null;
  };
  now: Date;
}

/**
 * Writes learning state on the activation transaction and returns the effect.
 * Use only that tx. Do not call a model or open another transaction.
 * The default throws, and the caller transaction rolls back.
 */
export type LearningSettlementPort = (input: ActivationSettleInput) => Promise<ActivationEffect>;

export class ActivationSettlementUnavailable extends Error {
  constructor() {
    super(
      'activateEvaluation: no LearningSettlementPort provided — learning settlement ' +
        'wiring is owned by YUK-1047; refusing to activate without it (fail-closed)',
    );
    this.name = 'ActivationSettlementUnavailable';
  }
}

export const settlementUnavailable: LearningSettlementPort = () => {
  throw new ActivationSettlementUnavailable();
};

export const ActivateEvaluationRequest = ActivateEvaluationIntent.extend({
  user_rating: FsrsRating.optional(),
  /** Extra constraint only. It cannot fill in a missing admission snapshot. */
  admission_generation_observed: z.number().int().min(0).optional(),
});
export type ActivateEvaluationRequestT = z.infer<typeof ActivateEvaluationRequest>;

export type ActivateEvaluationResult =
  | { status: 'activated'; effect: ActivationEffect; generation: number }
  | { status: 'already_effective'; effect: 'idempotent_replay'; generation: number }
  | {
      status:
        | 'not_found'
        | 'not_completed'
        | 'occurrence_withdrawn'
        | 'head_missing'
        | 'coordinate_mismatch'
        | 'stale_admission'
        | 'rating_conflict';
    }
  | { status: 'cas_conflict'; conflict: 'stale_head' | 'generation_mismatch' };

/**
 * Insert the first head row. This function opens no transaction.
 * The caller must already hold the one that inserted the submission and the group.
 */
export async function insertInitialEvaluationHead(
  tx: Tx,
  input: { evaluation_group_id: EvaluationGroupIdT; submission_id: SubmissionIdT; now?: Date },
): Promise<void> {
  await tx.insert(evaluation_effective_head).values({
    evaluation_group_id: input.evaluation_group_id,
    submission_id: input.submission_id,
    effective_evaluation_id: null,
    generation: 0,
    updated_at: input.now ?? new Date(),
  });
}

export async function activateEvaluation(
  tx: Tx,
  rawInput: ActivateEvaluationRequestT,
  options: {
    settle?: LearningSettlementPort;
    actorRef?: string;
    now?: Date;
    allowCapturedOriginal?: boolean;
  } = {},
): Promise<ActivateEvaluationResult> {
  const input = ActivateEvaluationRequest.parse(rawInput);
  const settle = options.settle ?? settlementUnavailable;
  const now = options.now ?? new Date();
  const actorRef = options.actorRef ?? 'assessment:activate';

  await acquireLearningStateWriteLock(tx);

  const [coordinate] = await tx
    .select({ groupId: evaluation.evaluation_group_id })
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, input.evaluation_id))
    .limit(1);
  if (!coordinate) return { status: 'not_found' };
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${coordinate.groupId}))`,
  );

  const [withdrawal] = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_settlement'),
        eq(event.subject_id, coordinate.groupId),
        sql`${event.payload}->>'effect' = 'withdrawn'`,
      ),
    )
    .limit(1);
  if (withdrawal) return { status: 'occurrence_withdrawn' };

  const [cand] = await tx
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, input.evaluation_id))
    .for('update')
    .limit(1);
  if (!cand) return { status: 'not_found' };
  if (cand.status !== 'completed') return { status: 'not_completed' };

  // Beyond the composite foreign key. A matching id can still point at another group.
  const [sub] = await tx
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.submission_id, cand.submission_id))
    .for('update')
    .limit(1);
  if (!sub) return { status: 'not_found' };
  if (sub.evaluation_group_id !== cand.evaluation_group_id) {
    return { status: 'coordinate_mismatch' };
  }

  // CAS serialization point.
  const [head] = await tx
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, cand.evaluation_group_id))
    .for('update')
    .limit(1);
  if (!head) return { status: 'head_missing' };
  if (head.submission_id !== sub.submission_id) return { status: 'coordinate_mismatch' };

  // The choice belongs to the candidate's first activation, not only to its
  // current effective tenure. Validate every old receipt before allowing ABA.
  const receipts = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, ASSESSMENT_ACTIVATION_ACTION),
        eq(event.subject_kind, 'evaluation_group'),
        eq(event.subject_id, cand.evaluation_group_id),
        sql`${event.payload}->>'evaluation_id' = ${cand.evaluation_id}`,
      ),
    );
  const firstChoice = receipts[0]?.payload?.user_rating;
  if (
    receipts.some((row) => row.payload?.user_rating !== firstChoice) ||
    (firstChoice !== undefined && !FsrsRating.safeParse(firstChoice).success)
  ) {
    return { status: 'rating_conflict' };
  }
  const previouslyActivated = receipts.length > 0;
  if (
    input.user_rating !== undefined &&
    (previouslyActivated || head.effective_evaluation_id === cand.evaluation_id) &&
    input.user_rating !== firstChoice
  )
    return { status: 'rating_conflict' };
  const userRating = previouslyActivated
    ? firstChoice === undefined
      ? undefined
      : FsrsRating.parse(firstChoice)
    : input.user_rating;

  const cas = resolveActivationCas(
    {
      evaluation_group_id: head.evaluation_group_id,
      submission_id: head.submission_id,
      effective_evaluation_id: head.effective_evaluation_id,
      generation: head.generation,
    },
    {
      evaluation_id: input.evaluation_id,
      expected_effective_id: input.expected_effective_id,
      expected_generation: input.expected_generation,
    },
  );
  if (!cas.ok) {
    if (cas.conflict === 'already_effective') {
      // Already effective. It was settled. Do not write again.
      return {
        status: 'already_effective',
        effect: 'idempotent_replay',
        generation: head.generation,
      };
    }
    return { status: 'cas_conflict', conflict: cas.conflict };
  }

  const [issuance] = await tx
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, sub.issuance_id))
    .limit(1);
  if (
    !issuance ||
    issuance.revision_id !== sub.revision_id ||
    issuance.container_occurrence_ref?.startsWith('probe:') ||
    (issuance.container_occurrence_ref?.startsWith('ingestion:') && !options.allowCapturedOriginal)
  ) {
    return { status: 'coordinate_mismatch' };
  }

  const [revRow] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, sub.revision_id))
    .limit(1);
  if (!revRow) return { status: 'not_found' };
  const questionGroupId = revRow.group_id;
  const [group] = await tx
    .select()
    .from(evaluation_group)
    .where(eq(evaluation_group.evaluation_group_id, cand.evaluation_group_id))
    .limit(1);
  const memberRows = await tx
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.evaluation_group_id, cand.evaluation_group_id));
  if (
    !group ||
    !sameMemberSet(
      group.submission_ids,
      memberRows.map((row) => row.submission_id),
    )
  ) {
    return { status: 'coordinate_mismatch' };
  }
  const memberIssuances = await tx
    .select()
    .from(assessment_issuance)
    .where(
      inArray(
        assessment_issuance.issuance_id,
        memberRows.map((row) => row.issuance_id),
      ),
    );
  let inputScope: ActivationSettleInput['inputScope'];
  try {
    const members = memberRows.map((row) => {
      const binding = memberIssuances.find((item) => item.issuance_id === row.issuance_id);
      if (!binding)
        throw new GroupInputContractError('invalid_group_input', 'missing member issuance');
      return evaluationMemberFromRows(row, binding);
    });
    const anchor = members.find((member) => member.submission.submission_id === sub.submission_id);
    if (!anchor) return { status: 'coordinate_mismatch' };
    const actual = freezeEvaluationInput(anchor.submission, revRow, members);
    const snapshot = cand.provenance?.input_snapshot;
    // Old single-member inputs are unambiguous and now sealed against append.
    // Historical joint candidates never acquire invented evidence at activation.
    if (snapshot == null ? members.length !== 1 : !matchesEvaluationInput(snapshot, actual)) {
      return { status: 'coordinate_mismatch' };
    }
    inputScope = actual;
  } catch (error) {
    if (!(error instanceof GroupInputContractError) && !(error instanceof z.ZodError)) throw error;
    return { status: 'coordinate_mismatch' };
  }

  // Same row lock publish and verify take.
  await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, questionGroupId))
    .for('update')
    .limit(1);

  const [lifecycle] = await tx
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, questionGroupId))
    .limit(1);

  // Missing lifecycle is unknown, not a legacy bypass. A caller token is only
  // an additional constraint; it cannot replace the candidate's frozen evidence.
  if (!lifecycle || lifecycle.suspended || lifecycle.withdrawn) {
    return { status: 'stale_admission' };
  }
  if (
    input.admission_generation_observed !== undefined &&
    lifecycle.scoring_admission_generation !== input.admission_generation_observed
  ) {
    return { status: 'stale_admission' };
  }
  const parsedProvenance = EvaluationProvenance.safeParse(cand.provenance ?? {});
  if (!parsedProvenance.success) return { status: 'stale_admission' };
  const provenance = parsedProvenance.data;
  // D9/D15: explicitly asserted user ratings do not need admitted marking rules.
  // Automatic scores require the server snapshot and current admission to agree
  // on the exact immutable revision and generation before any learning write.
  if (provenance.source === 'automatic') {
    const snapshot = provenance.admission_snapshot;
    if (
      !snapshot ||
      snapshot.current_revision_id !== sub.revision_id ||
      snapshot.state !== 'admitted' ||
      snapshot.suspended ||
      snapshot.withdrawn ||
      lifecycle.current_revision_id !== sub.revision_id ||
      lifecycle.scoring_admission_state !== 'admitted' ||
      snapshot.generation !== lifecycle.scoring_admission_generation
    ) {
      return { status: 'stale_admission' };
    }
  }

  const effect = await settle({
    tx,
    evaluation: cand,
    submission: sub,
    head,
    issuance,
    questionGroupId,
    inputScope,
    userRating,
    reusesActivation: previouslyActivated,
    now,
  });

  const nextGeneration = head.generation + 1;
  const advanced = await tx
    .update(evaluation_effective_head)
    .set({
      effective_evaluation_id: cand.evaluation_id,
      generation: nextGeneration,
      updated_at: now,
    })
    .where(
      and(
        eq(evaluation_effective_head.evaluation_group_id, head.evaluation_group_id),
        // The row is locked. Refuse the write when the expected id or generation no longer matches.
        input.expected_effective_id === null
          ? isNull(evaluation_effective_head.effective_evaluation_id)
          : eq(evaluation_effective_head.effective_evaluation_id, input.expected_effective_id),
        eq(evaluation_effective_head.generation, input.expected_generation),
      ),
    )
    .returning({ evaluation_group_id: evaluation_effective_head.evaluation_group_id });

  // Zero rows means the advance did not happen. Do not write a receipt or report activated.
  if (advanced.length === 0) {
    const [post] = await tx
      .select({ submission_id: evaluation_effective_head.submission_id })
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, head.evaluation_group_id))
      .limit(1);
    if (!post || post.submission_id !== sub.submission_id) {
      return { status: 'coordinate_mismatch' };
    }
    return { status: 'cas_conflict', conflict: 'stale_head' };
  }

  await writeEvent(tx, {
    id: `evt_act_${createId()}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: actorRef,
    action: ASSESSMENT_ACTIVATION_ACTION,
    subject_kind: 'evaluation_group',
    subject_id: cand.evaluation_group_id,
    outcome: 'success',
    payload: {
      version: ASSESSMENT_ACTIVATION_VERSION,
      evaluation_id: cand.evaluation_id,
      submission_id: sub.submission_id,
      issuance_id: sub.issuance_id,
      revision_id: sub.revision_id,
      question_group_id: questionGroupId,
      expected_effective_id: input.expected_effective_id,
      effective_evaluation_id: cand.evaluation_id,
      generation: nextGeneration,
      effect,
      attempt: cand.attempt,
      ...(userRating === undefined ? {} : { user_rating: userRating }),
    } satisfies Record<string, unknown>,
  });

  return { status: 'activated', effect, generation: nextGeneration };
}

/**
 * Touches only the claim columns. The binding columns stay frozen by the trigger.
 * A withdrawn question keeps lifecycle.suspended. The next issue read still refuses it.
 * Anything other than claimed is left as it is.
 */
export async function releaseIssuanceClaim(
  tx: Tx,
  issuanceId: IssuanceIdT,
): Promise<{ released: boolean }> {
  const rows = await tx
    .update(assessment_issuance)
    .set({ claim_status: 'released', claimed_by_ref: null })
    .where(
      and(
        eq(assessment_issuance.issuance_id, issuanceId),
        eq(assessment_issuance.claim_status, 'claimed'),
      ),
    )
    .returning({ issuance_id: assessment_issuance.issuance_id });
  return { released: rows.length > 0 };
}

export type {
  EvaluationGroupIdT,
  EvaluationIdT,
  EvaluationRecordT,
  IssuanceIdT,
  RevisionIdT,
  SubmissionIdT,
};
