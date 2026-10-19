// One rule for whether a frozen reference may be shown. Practice hint
// fallback and note-generation fallback both call this module: issued sol_*
// material, else the issued scoring basis; the prompt is the frozen issued
// face; intervention diagnostics and container occurrences are not assistable;
// a solution exposure is written only while the issuance row is locked and the
// coordinate still matches.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import {
  type AssessmentIssuanceT,
  type PracticeIssuanceDtoT,
  type PublishedQuestionRevisionT,
  describeSelectItem,
  projectIssuedScoringBasis,
  projectPracticeIssuance,
} from '@/core/schema/assessment';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { assessment_issuance, event, question, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';

const FROZEN_SOLUTION_ASSET_RE = /^sol_[0-9a-f]{12}$/;
export const STUDY_ASSISTANCE_ACTION = 'experimental:assessment_assistance';

export type StudyAssistanceImpact = 'answer_help' | 'harmless_clarification' | 'unknown';

export type StudyAssistanceGate = 'assistable' | 'reveal_unavailable';

export type IssuanceStudyCoordinate = {
  issuance: typeof assessment_issuance.$inferSelect;
  revision: typeof question_revision.$inferSelect;
  questionId: string;
};

export type IssuanceStudyLoad =
  | { status: 'not_found' }
  | { status: 'coordinate_mismatch' }
  | ({ status: 'reveal_unavailable' } & IssuanceStudyCoordinate)
  | ({ status: 'assistable' } & IssuanceStudyCoordinate);

export interface FrozenStudyReference {
  practiceDto: PracticeIssuanceDtoT;
  /** Frozen issued face (public materials + part prompts). */
  promptMd: string;
  /** Issued-scope sol_* text, or null when that scope has none. */
  solutionMd: string | null;
  /** sol_* when present, otherwise the issued scoring-basis text, otherwise null. */
  referenceMd: string | null;
}

/** Study assistance is refused for intervention diagnostics and container occurrences. */
export function studyAssistanceGate(input: {
  questionSource: string | null | undefined;
  containerOccurrenceRef: string | null;
}): StudyAssistanceGate {
  if (
    input.questionSource === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE ||
    input.containerOccurrenceRef
  ) {
    return 'reveal_unavailable';
  }
  return 'assistable';
}

function issuedPromptMd(face: PracticeIssuanceDtoT): string {
  return [
    ...face.materials.flatMap((material) => (material.content_md ? [material.content_md] : [])),
    ...face.faces.map((part) => part.prompt_md),
  ].join('\n\n');
}

function scoringBasisReferenceMd(
  face: PracticeIssuanceDtoT,
  revision: PublishedQuestionRevisionT,
  issuedPartIds: readonly string[],
): string {
  const basis = projectIssuedScoringBasis(revision, issuedPartIds);
  return basis.units
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
          slot.kind === 'matching' ? slot.left_items : slot.kind === 'ordering' ? slot.items : [];
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
        case 'position_set_key':
          // ADR-0074 D3a 断句：参考 = 接受断点集合（code point 字缝索引）；
          // 对应冻结明文已在 response_spec 槽位里，不在此重建文本。
          return criterion.accepted_positions.map((position) => `断点 ${position}`).join('\n');
        case 'select_key': {
          const selectSlot = slots.find((slot) => slot.kind === 'select');
          return criterion.accepted_item_ids
            .map((id) => (selectSlot?.kind === 'select' ? describeSelectItem(selectSlot, id) : id))
            .join('\n');
        }
        case 'blank_key':
          return criterion.key.kind === 'text'
            ? criterion.key.accepted.join('\n\n')
            : `${criterion.key.expected}${criterion.key.expected_unit ? ` ${criterion.key.expected_unit}` : ''}`;
        case 'rubric':
          // YUK-1496 C2：参考 = 逐 criterion 细则 + 可选参考解答。
          return [
            ...criterion.criteria.map(
              (item) => `${item.criterion_id}（满分 ${item.max}）：${item.statement_md}`,
            ),
            ...(criterion.reference_md ? [criterion.reference_md] : []),
          ].join('\n');
        default: {
          const exhaustive: never = criterion;
          return exhaustive;
        }
      }
    })
    .join('\n\n');
}

/** Public issued prompt only. Does not read scoring basis or sol_* material. */
export function projectFrozenIssuedPrompt(
  revision: PublishedQuestionRevisionT,
  issuance: AssessmentIssuanceT,
): string {
  return issuedPromptMd(projectPracticeIssuance(revision, issuance));
}

/**
 * Frozen reference for an issuance that has already passed the assistance gate.
 * sol_* scoped to the issued parts wins; the issued scoring basis is the fallback.
 */
export function projectFrozenStudyReference(
  revision: PublishedQuestionRevisionT,
  issuance: AssessmentIssuanceT,
): FrozenStudyReference {
  const face = projectPracticeIssuance(revision, issuance);
  const issuedPartIds = issuance.binding.part_ids;
  const issuedParts = new Set(issuedPartIds);
  const scopedMaterials = new Set(
    revision.structure.parts
      .filter((part) => issuedParts.has(part.part_id))
      .flatMap((part) => part.material_ids),
  );
  const solution = revision.structure.materials
    .filter(
      (material) =>
        scopedMaterials.has(material.material_id) &&
        FROZEN_SOLUTION_ASSET_RE.test(material.asset.asset_id),
    )
    .map((material) => material.content_md)
    .filter((text): text is string => Boolean(text))
    .join('\n\n');
  const scoringBasisMd = scoringBasisReferenceMd(face, revision, issuedPartIds);
  return {
    practiceDto: face,
    promptMd: issuedPromptMd(face),
    solutionMd: solution || null,
    referenceMd: solution || scoringBasisMd || null,
  };
}

/** Was this issuance's solution already shown through the reveal path? */
export async function hasPriorSolutionExposure(db: Db | Tx, issuanceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, STUDY_ASSISTANCE_ACTION),
        eq(event.subject_id, issuanceId),
        sql`${event.payload}->>'kind' = 'solution'`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Load the frozen issuance coordinate and the assistance gate. Callers map
 * not_found / coordinate_mismatch / reveal_unavailable to their own outcome.
 */
export async function loadIssuanceStudyCoordinate(
  database: Db | Tx,
  issuanceId: string,
  questionId?: string,
): Promise<IssuanceStudyLoad> {
  const [issuance] = await database
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, issuanceId))
    .limit(1);
  if (!issuance) return { status: 'not_found' };
  const [revision] = await database
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id))
    .limit(1);
  if (
    !revision ||
    (questionId && revision.group_id !== questionId && !issuance.part_ids.includes(questionId))
  ) {
    return { status: 'coordinate_mismatch' };
  }
  const resolvedQuestionId = questionId ?? revision.group_id;
  const [identity] = await database
    .select({ source: question.source })
    .from(question)
    .where(eq(question.id, resolvedQuestionId))
    .limit(1);
  const gate = studyAssistanceGate({
    questionSource: identity?.source,
    containerOccurrenceRef: issuance.container_occurrence_ref,
  });
  return {
    status: gate,
    issuance,
    revision,
    questionId: resolvedQuestionId,
  };
}

/**
 * Record one assistance exposure. Locks the issuance and re-checks the
 * coordinate inside that lock, sharing the lock with submission snapshots.
 */
export async function recordStudyAssistanceExposure(
  database: Db | Tx,
  input: {
    issuanceId: string;
    questionId: string;
    kind: 'hint' | 'solution' | 'chat_context';
    impact: StudyAssistanceImpact;
    contentDigest: string;
    actorRef: string;
  },
): Promise<string> {
  return database.transaction(async (tx) => {
    const [issuance] = await tx
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, input.issuanceId))
      .for('update')
      .limit(1);
    if (!issuance) throw new ApiError('not_found', 'issued assessment not found', 404);
    const [revision] = await tx
      .select({ group_id: question_revision.group_id })
      .from(question_revision)
      .where(eq(question_revision.revision_id, issuance.revision_id))
      .limit(1);
    if (
      !revision ||
      (revision.group_id !== input.questionId && !issuance.part_ids.includes(input.questionId))
    ) {
      throw new ApiError('coordinate_mismatch', 'assistance is outside the frozen issuance', 409);
    }
    return writeEvent(tx, {
      id: `evt_help_${createId()}`,
      actor_kind: 'system',
      actor_ref: input.actorRef,
      action: STUDY_ASSISTANCE_ACTION,
      subject_kind: 'issuance',
      subject_id: input.issuanceId,
      outcome: null,
      payload: {
        version: 1,
        kind: input.kind,
        impact: input.impact,
        content_digest: input.contentDigest,
      },
    });
  });
}
