// Settlement replay closure, occurrence ordering and candidate history assembly.
// Legacy plans are re-derived through the writer-bound port; the shared ledger
// owns sealed receipt decoding and liveness without depending on recovery.

import { eq } from 'drizzle-orm';

import {
  type SealedCandidateInput,
  candidatePointsForAdmission,
  initialCandidateState,
  rebuildCandidate,
  sealCandidateFact,
  validateCandidateInput,
} from '@/core/scheduling/candidate';
import { EvaluationProvenance } from '@/core/schema/assessment';
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  question_revision,
} from '@/db/schema';
import {
  type AppliedSettlementEvent,
  type FsrsSubject,
  type SettlementPlan,
  liveAppliedSettlements,
  loadSettlementEvents,
  subjectKey,
} from '@/kernel/read-models/assessment-settlements';
import type { ActivationSettleInput } from './activate';

export function candidateSchedulingSuppressed(plan: SettlementPlan): boolean {
  if (plan.forgettingSuppressed) return true;
  const selfReport = plan.forgettingInput
    ? plan.forgettingInput.fact.source === 'self_report'
    : plan.ratingSource === 'user';
  return (
    !selfReport &&
    (plan.verdict.verdict === 'unsupported' ||
      plan.provenance.assisted ||
      (plan.forgettingInput !== undefined &&
        (plan.forgettingInput.fact.help !== 'none' ||
          (plan.forgettingInput.fact.hints_used ?? 0) > 0 ||
          (plan.forgettingInput.fact.final_hint_level ?? 0) > 0)))
  );
}

/** Revert/re-apply order follows occurrence time then immutable submission ID. */
export function byOccurrenceAsc(a: AppliedSettlementEvent, b: AppliedSettlementEvent): number {
  return (
    a.occurrenceMs - b.occurrenceMs ||
    (a.inputs.submissionId < b.inputs.submissionId
      ? -1
      : a.inputs.submissionId > b.inputs.submissionId
        ? 1
        : 0)
  );
}

/**
 * Seed is live settlements at or after the bound whose subjects intersect.
 * Each member's subjects pull in more settlements at that same bound.
 * The replaced settlement of this group stays out. The replaced channel handles it.
 */
export function replayClosure(
  live: AppliedSettlementEvent[],
  input: {
    minOccurrenceMs: number;
    minSubmissionId?: string;
    excludeGroupId: string;
    seedSubjects: Set<string>;
  },
): AppliedSettlementEvent[] {
  const members = new Map<string, AppliedSettlementEvent>();
  const covered = new Set<string>(input.seedSubjects);
  const eligible = (m: AppliedSettlementEvent): boolean =>
    m.groupId !== input.excludeGroupId &&
    (m.occurrenceMs > input.minOccurrenceMs ||
      (m.occurrenceMs === input.minOccurrenceMs &&
        (!input.minSubmissionId || m.inputs.submissionId >= input.minSubmissionId)));
  const absorb = (m: AppliedSettlementEvent) => {
    if (members.has(m.id)) return;
    members.set(m.id, m);
    for (const s of m.subjects) covered.add(s);
  };
  for (const m of live) {
    if (!eligible(m)) continue;
    for (const s of m.subjects) {
      if (input.seedSubjects.has(s)) {
        absorb(m);
        break;
      }
    }
  }
  // Pull in every eligible member that touches a covered subject. The live set is finite.
  for (;;) {
    let grew = false;
    for (const m of live) {
      if (members.has(m.id) || !eligible(m)) continue;
      for (const s of m.subjects) {
        if (covered.has(s)) {
          absorb(m);
          grew = true;
          break;
        }
      }
    }
    if (!grew) return [...members.values()];
  }
}

/**
 * Re-derives the plan a sealed legacy row predates, from a reconstructed
 * activation input. Bound by the writer (settle.ts rederiveSettlementPlan):
 * loadScope/derivePlan stay write-side internals, so history assembly reaches
 * them only through this port. Returns the rebuilt plan and whether the scope
 * came from the frozen learning-scope snapshot.
 */
export type RederiveSettlementPlan = (
  tx: Tx,
  input: ActivationSettleInput,
) => Promise<{ plan: SettlementPlan; frozenLearningScope: boolean }>;

export async function candidateHistory(
  tx: Tx,
  subject: FsrsSubject,
  current: SettlementPlan | null,
  cutoff: Date,
  rederive: RederiveSettlementPlan,
  resolvedPlans?: SettlementPlan[],
  historySubjectIds: string[] = [],
): Promise<SealedCandidateInput[]> {
  const live = liveAppliedSettlements(await loadSettlementEvents(tx));
  const plans = resolvedPlans
    ? [...resolvedPlans].filter(
        (p) => p.submissionId !== current?.submissionId && new Date(p.occurrenceAt) <= cutoff,
      )
    : live
        .filter(
          (m) =>
            [subject.id, ...historySubjectIds].some((id) =>
              m.fsrsApplied.includes(subjectKey(subject.kind, id)),
            ) &&
            m.inputs.submissionId !== current?.submissionId &&
            m.occurrenceMs <= cutoff.getTime(),
        )
        .map((m) => m.inputs);
  if (current) plans.push(current);
  const facts: SealedCandidateInput[] = [];
  for (const plan of plans) {
    if (candidateSchedulingSuppressed(plan)) continue;
    if (plan.forgettingInput) {
      facts.push(validateCandidateInput(plan.forgettingInput));
      continue;
    }
    const [sub] = await tx
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, plan.submissionId));
    const [evalRow] = await tx
      .select()
      .from(evaluation)
      .where(eq(evaluation.evaluation_id, plan.evaluationId));
    if (!sub || !evalRow) throw new Error('sealed attempt history unavailable');
    const [issuance] = await tx
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, sub.issuance_id));
    const [head] = await tx
      .select()
      .from(evaluation_effective_head)
      .where(eq(evaluation_effective_head.evaluation_group_id, plan.groupId));
    const [revision] = await tx
      .select({ group_id: question_revision.group_id })
      .from(question_revision)
      .where(eq(question_revision.revision_id, sub.revision_id));
    if (!issuance || !head || !revision) throw new Error('sealed attempt coordinates unavailable');
    const frozenInput = EvaluationProvenance.parse(evalRow.provenance).input_snapshot;
    const input: ActivationSettleInput = {
      tx,
      submission: sub,
      evaluation: evalRow,
      issuance,
      head,
      questionGroupId: revision.group_id,
      inputScope: {
        issued_part_ids: frozenInput?.issued_part_ids ?? issuance.part_ids,
        occurrence_at: plan.occurrenceAt,
        member_submission_ids: frozenInput?.member_submission_ids ?? [sub.submission_id],
      },
      now: new Date(plan.occurrenceAt),
      ...(plan.ratingSource === 'user' && plan.rating ? { userRating: plan.rating } : {}),
    };
    const { plan: rebuilt, frozenLearningScope } = await rederive(tx, input);
    if (current && plan === current) {
      current.forgettingSuppressed = rebuilt.forgettingSuppressed;
    }
    if (rebuilt.forgettingSuppressed) continue;
    if (!rebuilt.forgettingInput) throw new Error('sealed candidate inputs unavailable');
    // Old settlements sealed their scheduling subjects even when no part/KC capture exists.
    // Use that frozen group scope, never today's mutable question labels or context.
    const historicalInput = frozenLearningScope
      ? rebuilt.forgettingInput
      : sealCandidateFact({
          ...rebuilt.forgettingInput.fact,
          context: null,
          legacyScopeVersion: plan.scopeVersion,
          points: rebuilt.forgettingInput.fact.points.map((p) => ({
            ...p,
            shares:
              p.shares.length === 0 ||
              (rebuilt.forgettingInput?.fact.source === 'judged' &&
                plan.fsrsSubjects.length > 1 &&
                p.earned > 0 &&
                p.earned < p.maximum)
                ? []
                : plan.fsrsSubjects.map((s) => ({
                    skillId: s.id,
                    share: 1 / plan.fsrsSubjects.length,
                  })),
          })),
        });
    facts.push(historicalInput);
    if (current && plan === current) current.forgettingInput = historicalInput;
  }
  return facts.map((input) => {
    if (!input.fact.points.some((p) => p.shares.some((s) => historySubjectIds.includes(s.skillId))))
      return input;
    return sealCandidateFact({
      ...input.fact,
      identityRemap: { fromIds: historySubjectIds, toId: subject.id },
      points: candidatePointsForAdmission(input.fact).map((p) => ({
        ...p,
        shares: p.shares.map((s) => ({
          ...s,
          skillId: historySubjectIds.includes(s.skillId) ? subject.id : s.skillId,
        })),
      })),
    });
  });
}

/** Read-only legacy conversion. Historical receipts and the stored projection are never rewritten. */
export async function candidateStateForRead(
  tx: Tx,
  subject: FsrsSubject,
  now: Date,
  rederive: RederiveSettlementPlan,
) {
  const history = await candidateHistory(tx, subject, null, now, rederive);
  if (history.length === 0)
    return { ...initialCandidateState(subject.id, now), conversion: 'legacy_cold' as const };
  const last = new Date(Math.max(...history.map((f) => f.fact.occurredAt.getTime())));
  return rebuildCandidate(subject.id, history, last, 'legacy_history');
}
