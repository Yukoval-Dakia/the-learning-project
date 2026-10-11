import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { deriveIssuanceBinding, projectPracticeIssuance } from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { assessment_issuance, question_group_lifecycle, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  ASSESSMENT_ISSUANCE_ACTION,
  type IssueAssessmentRequest,
  issuanceRowToContract,
  revisionRowToContract,
} from '@/kernel/records/assessment-issuance';

/** Seed already-issued historical work for recovery/settlement tests, never new serving authority. */
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
      claim_policy: 'unbounded',
      claim_status: 'unclaimed',
      claimed_by_ref: null,
    })
    .returning();
  if (!inserted) throw new Error('historical fixture insertion failed');
  await writeEvent(db, {
    id: `evt_historical_${createId()}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'test:historical-issuance',
    action: ASSESSMENT_ISSUANCE_ACTION,
    subject_kind: 'issuance',
    subject_id: issuanceId,
    payload: { admission_generation_observed: lifecycle?.scoring_admission_generation ?? null },
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
