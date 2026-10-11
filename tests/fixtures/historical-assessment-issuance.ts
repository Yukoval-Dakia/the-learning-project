import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { deriveIssuanceBinding, projectPracticeIssuance } from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { assessment_issuance, question_group_lifecycle, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  ASSESSMENT_ISSUANCE_ACTION,
  ASSESSMENT_ISSUANCE_VERSION,
  type IssueAssessmentRequest,
  issuanceRowToContract,
  revisionRowToContract,
} from '@/kernel/records/assessment-issuance';

/**
 * Seed already-issued historical work for recovery/settlement tests, never new
 * serving authority. The row mirrors what `issueAssessment` persists (binding,
 * claim columns, receipt event payload), except the serving gate is not
 * re-asked — the frozen contract may legitimately be unservable now.
 */
export async function seedHistoricalAssessmentIssuance(
  db: Db | Tx,
  request: IssueAssessmentRequest,
) {
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, request.group_id));
  const revisionId = request.revision_id ?? lifecycle?.current_revision_id;
  if (!revisionId) throw new Error('historical fixture needs a published revision');
  const [row] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, revisionId));
  if (!row || row.group_id !== request.group_id)
    throw new Error('historical fixture revision mismatch');
  const revision = revisionRowToContract(row);
  const binding = deriveIssuanceBinding(revision, request);
  const issuanceId = request.issuance_id ?? `iss_historical_${createId()}`;
  const now = request.now ?? new Date();

  // Same one_time mutual exclusion as issueAssessment step 6: a second claimed
  // issuance on the group is a state the real gate could never produce.
  const claimPolicy = lifecycle?.claim_policy ?? 'unbounded';
  const claimRequested = claimPolicy === 'one_time' || request.claim != null;
  if (claimRequested && claimPolicy === 'one_time') {
    const [holder] = await db
      .select({ issuance_id: assessment_issuance.issuance_id })
      .from(assessment_issuance)
      .innerJoin(
        question_revision,
        eq(assessment_issuance.revision_id, question_revision.revision_id),
      )
      .where(
        and(
          eq(question_revision.group_id, request.group_id),
          eq(assessment_issuance.claim_status, 'claimed'),
        ),
      )
      .limit(1);
    if (holder) throw new Error('claim_unavailable');
  }
  const claimStatus = claimRequested ? ('claimed' as const) : ('unclaimed' as const);
  const claimedByRef = claimRequested ? (request.claim?.claimed_by_ref ?? issuanceId) : null;

  const [inserted] = await db
    .insert(assessment_issuance)
    .values({
      issuance_id: issuanceId,
      revision_id: revisionId,
      part_ids: binding.part_ids,
      material_bindings: binding.material_bindings,
      option_order: binding.option_order,
      issued_at: now,
      container_occurrence_ref: request.container_occurrence_ref ?? null,
      claim_policy: claimPolicy,
      claim_status: claimStatus,
      claimed_by_ref: claimedByRef,
    })
    .returning();
  if (!inserted) throw new Error('historical fixture insertion failed');
  await writeEvent(db, {
    id: `evt_historical_${createId()}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: request.actorRef ?? 'test:historical-issuance',
    action: ASSESSMENT_ISSUANCE_ACTION,
    subject_kind: 'issuance',
    subject_id: issuanceId,
    outcome: 'success',
    payload: {
      version: ASSESSMENT_ISSUANCE_VERSION,
      issuance_id: issuanceId,
      group_id: request.group_id,
      revision_id: revision.revision_id,
      part_ids: binding.part_ids,
      material_bindings: binding.material_bindings,
      option_order: binding.option_order,
      container_occurrence_ref: request.container_occurrence_ref ?? null,
      claim_policy: claimPolicy,
      claim_status: claimStatus,
      claimed_by_ref: claimedByRef,
      admission_generation_observed: lifecycle?.scoring_admission_generation ?? null,
      mode: request.mode ?? 'auto_score',
    },
    created_at: now,
  });
  const issuance = issuanceRowToContract(inserted);
  return {
    status: 'issued' as const,
    issuance,
    practice_dto: projectPracticeIssuance(revision, issuance),
    admission_generation_observed: lifecycle?.scoring_admission_generation ?? null,
  };
}
