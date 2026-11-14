import { eq } from 'drizzle-orm';
import type { SlotResponseT } from '@/core/schema/assessment/response';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { loadAssessmentLearningScope } from '@/kernel/read-models/assessment-learning-scope';
import {
  type NativeAttemptVerdict,
  nativeAttemptOutcome,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { getFailureAttemptForDerivationById } from '@/kernel/read-models/failure-attempts';
import { projectFrozenStudyContext } from '../../grading/public';
import { type GradingEvidence, extractGradingEvidence } from '../tasks/attribution-evidence';

/** Outcomes automatic attribution may attribute a cause for. */
const ATTRIBUTABLE_OUTCOMES = new Set(['failure', 'partial']);

/**
 * Same eligibility the learner-cause write owner accepts: an effective
 * failure/partial verdict, or a non-self-report `partial_unknown_points`.
 * Anything else (correct, pending, self-report, unsupported) stays out of the
 * paid attribution lane.
 */
export function nativeAttemptAttributable(verdict: NativeAttemptVerdict | undefined): boolean {
  const outcome = nativeAttemptOutcome(verdict);
  if (ATTRIBUTABLE_OUTCOMES.has(outcome)) return true;
  const selected = verdict?.effective;
  return (
    selected?.row.provenance?.source !== 'self_report' &&
    selected?.verdict.verdict === 'unsupported' &&
    selected.verdict.reason === 'partial_unknown_points'
  );
}

/**
 * Whether any frozen entry carries learner-readable text the text-only
 * attribution task can consume. Photo or evidence-only submissions leave the
 * attribution text to grading observations instead.
 */
export function entriesCarryText(entries: readonly SlotResponseT[]): boolean {
  return entries.some((entry) =>
    entry.kind === 'text' || entry.kind === 'open' ? entry.text_md.trim().length > 0 : true,
  );
}

/**
 * Attribution text for an image-only submission: only frozen grading model
 * observations, labelled as unverified. Nothing is invented and no other
 * source is substituted, so a photo submission without observations stays
 * ineligible rather than fabricating learner text.
 */
export function photoObservationAnswerMd(evidence: GradingEvidence): string | null {
  const lines = evidence.units.flatMap((unit) =>
    unit.model_observations.map(
      (observation) =>
        `- [${unit.scoring_unit_id}] ${observation.observation_md}（模型观察，未校验）`,
    ),
  );
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Content and scope for attribution come from the original issuance and submission. */
export async function loadNativeFailureContext(db: Db | Tx, attemptEventId: string) {
  const [anchor] = await db.select().from(event).where(eq(event.id, attemptEventId));
  if (anchor?.action !== 'experimental:assessment_attempt') return null;
  const verdict = (await resolveVerdictsForNativeAttempts(db, [anchor])).get(anchor.id);
  if (!verdict?.effective || !nativeAttemptAttributable(verdict)) return null;
  if (!(await getFailureAttemptForDerivationById(db, attemptEventId, { causeEditable: true })))
    return null;
  const scope = await loadAssessmentLearningScope(
    db,
    verdict.submission.submission_id,
    verdict.revision.group_id,
  );
  if (!scope) return null;
  const context = projectFrozenStudyContext(verdict.revision, verdict.issuance);
  const grading = extractGradingEvidence({
    unitResults: verdict.effective.row.unit_results,
    scoringBasis: verdict.revision.scoring_basis,
    responseSpec: verdict.revision.response_spec,
    issuedPartIds: verdict.issuance.part_ids,
  });
  const entries = verdict.submission.response_set.entries;
  // The attribution task is text-only. Image metadata is not the student's image content.
  const textAnswerMd = entriesCarryText(entries)
    ? JSON.stringify(verdict.submission.response_set)
    : null;
  // Photo-only or otherwise text-free work attributes only on frozen grading
  // observations; an attempt with none stays unknown instead of inventing text.
  const answerMd = textAnswerMd ?? photoObservationAnswerMd(grading.evidence);
  if (answerMd === null) return null;
  return {
    question: scope.questions.find((item) => item.id === verdict.revision.group_id),
    evaluationGroupId: verdict.submission.evaluation_group_id,
    evaluationId: verdict.effective.row.evaluation_id,
    prompt_md: `${context.prompt_md}\n\nIssued response controls:\n${JSON.stringify(context.practice_dto.response_spec)}`,
    reference_md: context.reference_md,
    answer_md: answerMd,
    knowledge_ids: verdict.knowledge_ids,
    revision_id: verdict.revision.revision_id,
    grading_evidence: grading.evidence,
    failed_part_ids: grading.failedPartIds,
  };
}
