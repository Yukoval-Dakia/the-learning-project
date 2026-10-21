import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  learning_session,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { PlacementQuestionSchema, type PlacementUnresolvedItem } from '../api/placement-contracts';
import { issueAssessment } from './assessment/issue';
import { getIssuanceState } from './assessment/submit';
import { readJudgeRunPermanent } from './judge-run-observation';
import { type SelectPlacementItemInput, selectNextPlacementItem } from './placement-select';

const ACTION = 'experimental:assessment_placement_issued';
/** Learner-released held issuance: recorded unresolved, never wrong. */
export const PLACEMENT_HELD_RELEASE_ACTION = 'experimental:assessment_placement_released';
const PlacementIssueReceipt = z.object({
  ordinal: z.number().int().positive(),
  questionId: z.string(),
  score: z.number(),
  scoreKind: z.enum(['mfi', 'klp', 'klp_grid']),
  issuance_id: z.string(),
  evaluation_group_id: z.string(),
  submission_id: z.string(),
  idempotency_key: z.string(),
  // Optional for receipts written before this field existed. supply_scope says which
  // selection tier produced the item ('scope' = the probe's own scope, 'nearby' = widened
  // same-subject scope); served_after_ms is the real elapsed session→first-item time,
  // emitted on ordinal 1 only.
  supply_scope: z.enum(['scope', 'nearby']).optional(),
  served_after_ms: z.number().int().nonnegative().optional(),
});
type Receipt = z.infer<typeof PlacementIssueReceipt>;

type AcceptedSubmission = {
  submission_id: string;
  evaluation_group_id: string;
};

/** The head/settlement read every unresolved classification shares. */
async function readPlacementItemSettlement(
  tx: Tx,
  accepted: AcceptedSubmission,
): Promise<{ settled: boolean; hasEffectiveHead: boolean }> {
  const [head] = await tx
    .select()
    .from(evaluation_effective_head)
    .where(eq(evaluation_effective_head.evaluation_group_id, accepted.evaluation_group_id));
  const settlements = head?.effective_evaluation_id
    ? await tx
        .select({ payload: event.payload })
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:assessment_settlement'),
            eq(event.subject_id, accepted.evaluation_group_id),
          ),
        )
        .orderBy(desc(event.created_at), desc(event.id))
    : [];
  // A moved head alone is insufficient: failed_pending/replay_required remains held.
  const settlement = settlements.find(
    (r) => r.payload?.evaluation_id === head?.effective_evaluation_id,
  );
  const settled =
    head?.submission_id === accepted.submission_id &&
    (settlement?.payload?.effect === 'applied' || settlement?.payload?.effect === 'ineligible');
  return { settled, hasEffectiveHead: head?.effective_evaluation_id != null };
}

/** Called under the placement session row lock. Verdicts never enter this public read model. */
export async function placementAssessmentProgress(tx: Tx, sessionId: string) {
  const answered = await tx
    .select({ questionId: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.subject_kind, 'question'),
        inArray(event.action, ['review', 'attempt', 'experimental:assessment_attempt']),
      ),
    );
  const answeredIds = new Set(answered.map((row) => row.questionId));
  const issued = await tx
    .select({ issuanceId: assessment_issuance.issuance_id, payload: event.payload })
    .from(assessment_issuance)
    .innerJoin(
      event,
      and(
        eq(event.subject_id, assessment_issuance.issuance_id),
        eq(event.action, ACTION),
        eq(event.session_id, sessionId),
      ),
    )
    .where(eq(assessment_issuance.container_occurrence_ref, `placement:${sessionId}`))
    .orderBy(asc(assessment_issuance.issued_at), asc(assessment_issuance.issuance_id));
  // Learner-released issuances never block again: the release event is the durable
  // "recorded unresolved" marker, so refresh/re-entry re-derives the same progress
  // without re-reading per-item judge state.
  const releasedRows = await tx
    .select({ issuanceId: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.action, PLACEMENT_HELD_RELEASE_ACTION),
        eq(event.subject_kind, 'issuance'),
      ),
    );
  const releasedIssuanceIds = new Set(releasedRows.map((r) => r.issuanceId));
  const releasedQuestionIds = new Set<string>();
  const unresolved: PlacementUnresolvedItem[] = [];
  let outstanding: z.infer<typeof PlacementQuestionSchema> | null = null;
  for (const row of issued) {
    const receipt = PlacementIssueReceipt.parse(row.payload);
    if (receipt.issuance_id !== row.issuanceId)
      throw new ApiError('corrupt_state', 'placement issuance receipt mismatch', 409);
    const state = await getIssuanceState(tx, row.issuanceId);
    const accepted = state.submissions[0];
    const released = releasedIssuanceIds.has(row.issuanceId);
    if (released) releasedQuestionIds.add(receipt.questionId);
    if (!accepted && answeredIds.has(receipt.questionId)) continue;
    if (!accepted && !released && state.practice_dto === null) {
      throw new ApiError(
        'not_admitted',
        'This frozen placement question cannot be automatically graded. End this placement session to continue safely.',
        409,
        undefined,
        // serving_reason 只用声明过的公共枚举；诊断不可用则如实 null，不造新枚举值。
        { serving_reason: state.unavailable_reason ?? null },
      );
    }
    if (accepted) answeredIds.add(receipt.questionId);
    // Released items are skipped as outstanding, but a late real settlement still
    // counts — the unresolved list only names items with no verdict at read time.
    const settlement = accepted
      ? await readPlacementItemSettlement(tx, accepted)
      : { settled: false, hasEffectiveHead: false };
    if (settlement.settled) continue;
    if (released) {
      unresolved.push({
        question_id: receipt.questionId,
        issuance_id: row.issuanceId,
        reason: 'held_released',
      });
      continue;
    }
    if (accepted) {
      unresolved.push({
        question_id: receipt.questionId,
        issuance_id: row.issuanceId,
        reason: 'awaiting_evaluation',
      });
    }
    let phase: 'answering' | 'retry' | 'pending' | 'held' = 'answering';
    let pendingRun: { run_id: string; poll_url: string } | null = null;
    if (accepted) {
      const candidates = await tx
        .select({ id: evaluation.evaluation_id })
        .from(evaluation)
        .where(eq(evaluation.submission_id, accepted.submission_id));
      const runId = `judge_native_${accepted.submission_id}`;
      const judge = await readJudgeRunPermanent(tx, runId);
      if (judge.kind !== 'absent') {
        phase = judge.kind === 'pending' ? 'pending' : 'held';
        if (phase === 'pending')
          pendingRun = {
            run_id: runId,
            poll_url: `/api/jobs/judge_run/${encodeURIComponent(runId)}/status`,
          };
      } else phase = candidates.length || settlement.hasEffectiveHead ? 'held' : 'retry';
    }
    // Never select past a persisted original awaiting evaluation or settlement.
    outstanding ??= PlacementQuestionSchema.parse({
      questionId: receipt.questionId,
      score: receipt.score,
      scoreKind: receipt.scoreKind,
      assessment: {
        ...receipt,
        state,
        phase,
        pending_run: pendingRun,
        // The typed exit travels with the held item itself: continue releases it
        // (recorded unresolved, never wrong), end closes the probe and marks it in
        // unresolved_items. Re-derived on every read, so refresh-safe.
        ...(phase === 'held'
          ? {
              held_exit: {
                issuance_id: receipt.issuance_id,
                continue_url: `/api/placement-sessions/${sessionId}/held-release`,
                end_url: `/api/placement-sessions/${sessionId}`,
              },
            }
          : {}),
      },
    });
  }
  return {
    answeredIds: [...answeredIds],
    answeredCount: answeredIds.size,
    outstanding,
    issuedCount: issued.length,
    unresolved,
    releasedIssuanceIds,
    releasedQuestionIds,
  };
}

/**
 * Reuse the outstanding issuance before selecting; new identities belong to a session ordinal.
 *
 * `input.fallbackKnowledgeIds` is the pre-resolved same-subject widened scope. Selection
 * tries the probe's own scope first and retries over the widened set only when the primary
 * is exhausted. Every candidate still passes selectNextPlacementItem → decideAutomaticServing,
 * so the fallback cannot serve a non-gradable item. The receipt records the producing tier
 * (`supply_scope`) and, for the first item, the real elapsed session→serve time.
 */
export async function ensurePlacementAssessment(
  tx: Tx,
  sessionId: string,
  input: SelectPlacementItemInput & { fallbackKnowledgeIds?: readonly string[] },
  progress: Awaited<ReturnType<typeof placementAssessmentProgress>>,
  ctx?: { startedAt?: Date | null },
) {
  if (progress.outstanding) return progress.outstanding;
  // Released held items are excluded too — a released item is never re-served.
  const exclude = new Set([
    ...progress.answeredIds,
    ...progress.releasedQuestionIds,
    ...(input.excludeQuestionIds ?? []),
  ]);
  const widened = Array.from(
    new Set([...input.knowledgeIds, ...(input.fallbackKnowledgeIds ?? [])]),
  );
  const tiers: { knowledgeIds: readonly string[]; supplyScope: 'scope' | 'nearby' }[] = [
    { knowledgeIds: input.knowledgeIds, supplyScope: 'scope' },
  ];
  if (widened.length > input.knowledgeIds.length) {
    tiers.push({ knowledgeIds: widened, supplyScope: 'nearby' });
  }
  // One shared attempt budget across tiers: an issuance failure in the primary scope
  // still counts toward the bound; the nearby tier only runs when the primary came
  // up empty of candidates.
  let budget = 200;
  for (const tier of tiers) {
    while (budget-- > 0) {
      const selection = await selectNextPlacementItem(tx, {
        ...input,
        knowledgeIds: tier.knowledgeIds,
        excludeQuestionIds: [...exclude],
      });
      if (!selection) break;
      const [q] = await tx
        .select({ id: question.id, parentId: question.parent_question_id })
        .from(question)
        .where(eq(question.id, selection.questionId));
      if (!q) {
        exclude.add(selection.questionId);
        continue;
      }
      const rootId = q.parentId ?? q.id;
      const [lifecycle] = await tx
        .select()
        .from(question_group_lifecycle)
        .where(eq(question_group_lifecycle.group_id, rootId));
      const [revision] = lifecycle?.current_revision_id
        ? await tx
            .select()
            .from(question_revision)
            .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
        : [];
      if (!revision) {
        exclude.add(q.id);
        continue;
      }
      const partIds = q.parentId ? [q.id] : revision.structure.parts.map((part) => part.part_id);
      const ordinal = progress.issuedCount + 1;
      const identity = canonicalHash({ sessionId, ordinal });
      const issued = await issueAssessment(tx, {
        issuance_id: `iss_placement_${identity}`,
        group_id: rootId,
        revision_id: revision.revision_id,
        part_ids: partIds,
        container_occurrence_ref: `placement:${sessionId}`,
        actorRef: 'assessment:placement',
      });
      if (issued.status !== 'issued' && issued.status !== 'replayed') {
        if (
          ['suspended', 'withdrawn', 'not_admitted', 'unpublished', 'not_found'].includes(
            issued.status,
          )
        ) {
          exclude.add(q.id);
          continue;
        }
        throw new ApiError(issued.status, `placement issuance unavailable: ${issued.status}`, 409);
      }
      const receipt: Receipt = PlacementIssueReceipt.parse({
        ...selection,
        ordinal,
        issuance_id: issued.issuance.issuance_id,
        evaluation_group_id: `eg_placement_${identity}`,
        submission_id: `sub_placement_${identity}`,
        idempotency_key: `placement_${identity}`,
        supply_scope: tier.supplyScope,
        ...(ordinal === 1 && ctx?.startedAt
          ? { served_after_ms: Math.max(0, Date.now() - ctx.startedAt.getTime()) }
          : {}),
      });
      await writeEvent(tx, {
        id: `evt_placement_${identity}`,
        session_id: sessionId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: ACTION,
        subject_kind: 'issuance',
        subject_id: receipt.issuance_id,
        outcome: null,
        payload: receipt,
      });
      return PlacementQuestionSchema.parse({
        ...selection,
        assessment: {
          ...receipt,
          state: await getIssuanceState(tx, receipt.issuance_id),
          phase: 'answering',
          pending_run: null,
        },
      });
    }
  }
  return null;
}

/**
 * Writes the durable held-release marker. The deterministic event id makes the record
 * exactly-once, and placementAssessmentProgress never surfaces the issuance as outstanding
 * again. No submission, verdict, or settlement is written: the item stays unresolved, never
 * wrong. A late judge settlement still lands on its own idempotent path.
 */
export async function writePlacementHeldRelease(
  tx: Tx,
  sessionId: string,
  outstanding: z.infer<typeof PlacementQuestionSchema>,
): Promise<void> {
  const assessment = outstanding.assessment;
  const [issueEvent] = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, ACTION),
        eq(event.subject_id, assessment.issuance_id),
        eq(event.session_id, sessionId),
      ),
    )
    .limit(1);
  await writeEvent(tx, {
    id: `evt_placement_release_${canonicalHash({ sessionId, issuanceId: assessment.issuance_id })}`,
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: PLACEMENT_HELD_RELEASE_ACTION,
    subject_kind: 'issuance',
    subject_id: assessment.issuance_id,
    outcome: null,
    payload: {
      question_id: outstanding.questionId,
      issuance_id: assessment.issuance_id,
      evaluation_group_id: assessment.evaluation_group_id,
      submission_id: assessment.submission_id,
      disposition: 'unresolved',
    },
    caused_by_event_id: issueEvent?.id ?? null,
  });
}

/**
 * Session info the advance path needs beyond the row lock's status/scope snapshot.
 * Plain read (the caller already holds the FOR UPDATE row lock).
 */
export async function readPlacementSessionInfo(
  tx: Tx,
  sessionId: string,
): Promise<{ goalId: string | null; startedAt: Date } | null> {
  const [row] = await tx
    .select({ goalId: learning_session.goal_id, startedAt: learning_session.started_at })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'placement')))
    .limit(1);
  return row ?? null;
}

/**
 * The honest end-of-probe list: every issued item with no verdict at read time. This LIGHT
 * reader needs no serving-decision state and never throws not_admitted, so a session can
 * always end/report honestly. Reasons:
 * held_released — learner released a held item (recorded unresolved).
 * awaiting_evaluation — submission accepted, no settlement yet.
 * unanswered — issued but never submitted.
 * An item answered through another path in the same session is not listed.
 */
export async function readPlacementUnresolvedItems(
  tx: Tx,
  sessionId: string,
): Promise<PlacementUnresolvedItem[]> {
  const answered = await tx
    .select({ questionId: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.subject_kind, 'question'),
        inArray(event.action, ['review', 'attempt', 'experimental:assessment_attempt']),
      ),
    );
  const answeredIds = new Set(answered.map((row) => row.questionId));
  const releasedRows = await tx
    .select({ issuanceId: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.action, PLACEMENT_HELD_RELEASE_ACTION),
        eq(event.subject_kind, 'issuance'),
      ),
    );
  const releasedIds = new Set(releasedRows.map((r) => r.issuanceId));
  const issued = await tx
    .select({ issuanceId: assessment_issuance.issuance_id, payload: event.payload })
    .from(assessment_issuance)
    .innerJoin(
      event,
      and(
        eq(event.subject_id, assessment_issuance.issuance_id),
        eq(event.action, ACTION),
        eq(event.session_id, sessionId),
      ),
    )
    .where(eq(assessment_issuance.container_occurrence_ref, `placement:${sessionId}`))
    .orderBy(asc(assessment_issuance.issued_at), asc(assessment_issuance.issuance_id));
  const items: PlacementUnresolvedItem[] = [];
  for (const row of issued) {
    const receipt = PlacementIssueReceipt.parse(row.payload);
    if (receipt.issuance_id !== row.issuanceId)
      throw new ApiError('corrupt_state', 'placement issuance receipt mismatch', 409);
    const [accepted] = await tx
      .select({
        submission_id: assessment_submission.submission_id,
        evaluation_group_id: assessment_submission.evaluation_group_id,
      })
      .from(assessment_submission)
      .where(eq(assessment_submission.issuance_id, row.issuanceId))
      .orderBy(desc(assessment_submission.submitted_at))
      .limit(1);
    if (accepted && (await readPlacementItemSettlement(tx, accepted)).settled) continue;
    if (releasedIds.has(row.issuanceId)) {
      items.push({
        question_id: receipt.questionId,
        issuance_id: row.issuanceId,
        reason: 'held_released',
      });
    } else if (accepted) {
      items.push({
        question_id: receipt.questionId,
        issuance_id: row.issuanceId,
        reason: 'awaiting_evaluation',
      });
    } else if (!answeredIds.has(receipt.questionId)) {
      items.push({
        question_id: receipt.questionId,
        issuance_id: row.issuanceId,
        reason: 'unanswered',
      });
    }
  }
  return items;
}

/** The placement occurrence's immutable coordinates also fence shared /attempts writes. */
export async function validatePlacementSubmission(
  database: import('@/db/client').Db,
  questionId: string,
  sessionId: string | null | undefined,
  input: import('./assessment/submit').SaveSubmissionRequest,
) {
  const [issuance] = await database
    .select({ container: assessment_issuance.container_occurrence_ref })
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, input.issuance_id));
  if (!issuance?.container?.startsWith('placement:')) return;
  if (!sessionId || issuance.container !== `placement:${sessionId}`)
    throw new ApiError('coordinate_mismatch', 'placement issuance belongs to another session', 409);
  const [row] = await database
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, ACTION),
        eq(event.subject_id, input.issuance_id),
        eq(event.session_id, sessionId),
      ),
    );
  const receipt = PlacementIssueReceipt.parse(row?.payload);
  if (
    receipt.questionId !== questionId ||
    receipt.evaluation_group_id !== input.evaluation_group_id ||
    receipt.submission_id !== input.submission_id ||
    receipt.idempotency_key !== input.idempotency_key
  )
    throw new ApiError(
      'coordinate_mismatch',
      'placement submission differs from its issued occurrence',
      409,
    );
}
