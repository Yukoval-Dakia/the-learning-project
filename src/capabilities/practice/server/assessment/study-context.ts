import { eq } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { projectIssuedScoringBasis, projectPracticeIssuance } from '@/core/schema/assessment';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import { assessment_issuance, question, question_revision } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { recordAssistanceExposure } from './assistance';
import { issuanceRowToContract, revisionRowToContract } from './issue';

/** Teaching receives exactly the issued face and published marking for its scope. */
export async function loadFrozenStudyContext(
  database: Db,
  issuanceId: string,
  questionId?: string,
) {
  const [issuance] = await database
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, issuanceId))
    .limit(1);
  if (!issuance) throw new ApiError('not_found', 'issued assessment not found', 404);
  const [row] = await database
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id))
    .limit(1);
  if (
    !row ||
    (questionId && row.group_id !== questionId && !issuance.part_ids.includes(questionId))
  ) {
    throw new ApiError('coordinate_mismatch', 'question is outside the frozen issuance', 409);
  }
  const [identity] = await database
    .select({ source: question.source })
    .from(question)
    .where(eq(question.id, questionId ?? row.group_id))
    .limit(1);
  if (
    identity?.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE ||
    issuance.container_occurrence_ref
  ) {
    throw new ApiError(
      'reveal_unavailable',
      'this assessment does not permit study assistance',
      409,
    );
  }
  return projectFrozenStudyContext(row, issuance, questionId);
}

/** Pure frozen projection; callers enforce their own disclosure boundary. */
export function projectFrozenStudyContext(
  row: typeof question_revision.$inferSelect,
  issuance: typeof assessment_issuance.$inferSelect,
  questionId?: string,
) {
  const revision = revisionRowToContract(row);
  const face = projectPracticeIssuance(revision, issuanceRowToContract(issuance));
  const basis = projectIssuedScoringBasis(revision, issuance.part_ids);
  const reference = basis.units
    .map((unit) => {
      // Option/item IDs are unique inside a slot, not globally across the issuance.
      const slots = face.response_spec.slots.filter((slot) =>
        unit.slot_refs.includes(slot.slot_id),
      );
      const options = new Map<string, string>();
      const items = new Map<string, string>();
      for (const slot of slots) {
        const slotOptions =
          'options' in slot ? slot.options : slot.kind === 'matching' ? slot.right_options : [];
        const slotItems =
          slot.kind === 'matching' ? slot.left_items : 'items' in slot ? slot.items : [];
        for (const option of slotOptions)
          options.set(option.option_id, `${option.label}. ${option.text}`);
        for (const item of slotItems) items.set(item.item_id, `${item.label}. ${item.text}`);
      }
      const criterion = unit.criterion;
      switch (criterion.kind) {
        case 'option_set_key':
          return criterion.accepted_option_ids.map((id) => options.get(id) ?? id).join('\n');
        case 'matching_pairs_key':
          return criterion.accepted_pairs
            .map(
              (pair) =>
                `${items.get(pair.item_id) ?? pair.item_id} → ${options.get(pair.option_id) ?? pair.option_id}`,
            )
            .join('\n');
        case 'text_key':
          return criterion.accepted_texts.join('\n\n');
        case 'numeric_key':
          return `${criterion.expected}${criterion.expected_unit ? ` ${criterion.expected_unit}` : ''}`;
        case 'rule_reference':
          return criterion.statement_md;
        case 'holistic_level':
          return criterion.levels.map((level) => level.descriptor_md).join('\n\n');
      }
    })
    .join('\n\n');
  const issuedParts = new Set(issuance.part_ids);
  const scopedMaterials = new Set(
    revision.structure.parts
      .filter((part) => issuedParts.has(part.part_id))
      .flatMap((part) => part.material_ids),
  );
  const solutions = revision.structure.materials.filter(
    (material) =>
      scopedMaterials.has(material.material_id) &&
      /^sol_[0-9a-f]{12}$/.test(material.asset.asset_id),
  );
  const solution = solutions
    .map((material) => material.content_md)
    .filter(Boolean)
    .join('\n\n');
  return {
    question_id: questionId ?? row.group_id,
    // Teaching needs the complete served controls/material metadata, not just flattened prose.
    practice_dto: face,
    prompt_md: [
      ...face.materials.flatMap((material) => (material.content_md ? [material.content_md] : [])),
      ...face.faces.map((part) => part.prompt_md),
    ].join('\n\n'),
    reference_md: solution || reference || null,
    solution_md: solution || null,
  };
}

export async function revealFrozenStudyReference(database: Db, issuanceId: string) {
  const context = await loadFrozenStudyContext(database, issuanceId);
  if (context.solution_md)
    await recordAssistanceExposure(database, {
      issuanceId,
      questionId: context.question_id,
      kind: 'solution',
      impact: 'answer_help',
      contentDigest: `sha256:${canonicalHash(context.solution_md)}`,
    });
  return { reference_md: context.solution_md };
}
