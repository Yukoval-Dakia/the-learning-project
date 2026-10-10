import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type {
  QuestionGroupStructureT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  ExecutionPlan,
  QuestionGroupStructure,
  ResponseSpec,
  ScoringBasis,
  isPublicSharedMaterial,
} from '@/core/schema/assessment';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';

/** Restore the normalizer's schema order after JSONB without changing frozen content. */
export function readFrozenAssessmentReviewContract(revision: {
  structure: unknown;
  response_spec: unknown;
  scoring_basis: unknown;
  execution_plan: unknown;
  integrity_digest: string;
}) {
  const frozen = {
    structure: revision.structure,
    response_spec: revision.response_spec,
    scoring_basis: revision.scoring_basis,
    execution_plan: revision.execution_plan,
  };
  const parsed = {
    structure: QuestionGroupStructure.parse(frozen.structure),
    response_spec: ResponseSpec.parse(frozen.response_spec),
    scoring_basis: ScoringBasis.parse(frozen.scoring_basis),
    execution_plan: ExecutionPlan.parse(frozen.execution_plan),
  };
  // Schema defaults and stripping unknown fields must not repair a changed revision.
  if (
    canonicalHash(frozen) !== canonicalHash(parsed) ||
    contractIntegrityDigest(parsed) !== revision.integrity_digest
  )
    throw new Error('Frozen assessment review contract integrity mismatch');
  return { ...parsed, integrity_digest: revision.integrity_digest };
}

export function projectAssessmentReviewMedia(structure: QuestionGroupStructureT) {
  const [part] = structure.parts;
  if (!part || structure.parts.length !== 1)
    return { reason: 'unsupported_group_contract' } as const;
  const materials = structure.materials.filter((material) =>
    part.material_ids.includes(material.material_id),
  );
  if (part.material_ids.some((id) => !materials.some((material) => material.material_id === id)))
    return { reason: 'missing_prompt_material' } as const;
  const figures = materials.filter(
    (material) => material.kind === 'figure' && isPublicSharedMaterial(material),
  );
  // Only the normalizer's exact stored role marker is supported. Human captions
  // and mutable row figures cannot establish that a material is a prompt diagram.
  if (figures.some((material) => material.alt_text !== 'figure (diagram)'))
    return { reason: 'ambiguous_prompt_figure' } as const;
  if (figures.some((material) => !/^sha256:[a-f0-9]{64}$/i.test(material.asset.digest)))
    return { reason: 'unverified_figure_digest' } as const;
  return {
    figures: figures.map((material) => ({
      asset_id: material.asset.asset_id,
      digest: material.asset.digest.slice('sha256:'.length).toLowerCase(),
    })),
  } as const;
}

/** The compared candidate is the rule we will admit, never a mutable row answer. */
export function projectAssessmentReviewQuestion(revision: {
  structure: QuestionGroupStructureT;
  response_spec: ResponseSpecT;
  scoring_basis: ScoringBasisT;
}) {
  const [part] = revision.structure.parts;
  const [slot] = revision.response_spec.slots;
  const [unit] = revision.scoring_basis.units;
  if (
    !part ||
    !slot ||
    !unit ||
    revision.structure.parts.length !== 1 ||
    revision.response_spec.slots.length !== 1 ||
    revision.scoring_basis.units.length !== 1 ||
    slot.part_id !== part.part_id ||
    unit.slot_refs.length !== 1 ||
    unit.slot_refs[0] !== slot.slot_id
  )
    return null;
  const criterion = unit.criterion;
  let reference: string;
  let equivalents: string[] = [];
  let choices: string[] | null = null;
  let judge: 'exact' | 'semantic' = 'exact';
  switch (criterion.kind) {
    case 'text_key':
      reference = criterion.accepted_texts[0] ?? '';
      equivalents = criterion.accepted_texts.slice(1);
      break;
    case 'numeric_key':
      reference = `${criterion.expected}${criterion.expected_unit ? ` ${criterion.expected_unit}` : ''}`;
      break;
    case 'option_set_key': {
      if (slot.kind !== 'single_choice' && slot.kind !== 'multi_choice') return null;
      const accepted = slot.options.filter((option) =>
        criterion.accepted_option_ids.includes(option.option_id),
      );
      if (accepted.length !== criterion.accepted_option_ids.length) return null;
      reference = accepted.map((option) => option.label).join('');
      choices = slot.options.map((option) => `${option.label}. ${option.text}`);
      break;
    }
    case 'rule_reference':
      if (criterion.probe_spec) return null;
      reference = criterion.statement_md;
      judge = 'semantic';
      break;
    case 'matching_pairs_key':
    case 'holistic_level':
      return null;
    default: {
      const exhaustive: never = criterion;
      return exhaustive;
    }
  }
  const shared = revision.structure.materials.filter((material) =>
    part.material_ids.includes(material.material_id),
  );
  // Marking rubrics are private authority and cannot enter the blind solver prompt.
  if (
    shared.some(
      (material) =>
        material.kind !== 'figure' &&
        isPublicSharedMaterial(material) &&
        material.caption !== 'stem/shared context',
    )
  )
    return null;
  const context = shared
    .filter(
      (material) => isPublicSharedMaterial(material) && material.caption === 'stem/shared context',
    )
    .map((material) => material.content_md ?? '')
    .filter(Boolean);
  return {
    prompt_md: [...context, part.prompt_md].join('\n\n'),
    reference_md: reference,
    choices_md: choices,
    judge_kind_override: judge,
    rubric_json: {
      reference_solution: { final_answer: reference, answer_equivalents: equivalents },
    },
  };
}

export const ASSESSMENT_REVIEW_POLICY = 'ingestion_assessment_review@1';
// The common job_events pruner retains this exact server-owned operation family.
export const ASSESSMENT_REVIEW_PREFIX = 'ingreview_v1_';

export const AssessmentReviewBinding = z.object({
  session_id: z.string(),
  block_id: z.string(),
  block_version: z.number().int().nonnegative(),
  question_id: z.string(),
  question_version: z.number().int().nonnegative(),
  group_id: z.string(),
  revision_id: z.string(),
  revision_digest: z.string(),
  admission_generation: z.number().int().nonnegative(),
  policy_id: z.literal(ASSESSMENT_REVIEW_POLICY),
});
export type AssessmentReviewBindingT = z.infer<typeof AssessmentReviewBinding>;

export function assessmentReviewOperationId(binding: AssessmentReviewBindingT): string {
  return `${ASSESSMENT_REVIEW_PREFIX}${canonicalHash({
    group: binding.group_id,
    revision: binding.revision_id,
    digest: binding.revision_digest,
    generation: binding.admission_generation,
    policy: binding.policy_id,
  })}`;
}

export function matchesAssessmentReviewBinding(
  frozen: AssessmentReviewBindingT,
  current: AssessmentReviewBindingT,
): boolean {
  return canonicalHash(frozen) === canonicalHash(current);
}

export const AssessmentReviewEvidence = z.object({
  subject_id: z.string(),
  verdict: z.enum(['pass', 'fail', 'unsupported', 'unknown_result']),
  reason: z.string().max(4096),
  compared_by: z.enum(['normalize', 'semantic', 'none']),
  solver_final_answer: z.string().max(16000).optional(),
  task_runs: z
    .array(
      z.object({
        id: z.string(),
        task_kind: z.string(),
        provider: z.string(),
        model: z.string(),
        status: z.string(),
        input_hash: z.string(),
        result_digest: z.string().nullable(),
        cost_usd: z.number().finite().nullable(),
        cost_basis: z.string().nullable(),
        cost_ref: z.string().nullable(),
      }),
    )
    .max(16),
});
export type AssessmentReviewEvidenceT = z.infer<typeof AssessmentReviewEvidence>;

/** Missing/corrupt results cannot release a committed paid-start fence. */
export function readAssessmentReviewStage(events: Array<{ eventType: string; payload: unknown }>) {
  const completed = events.find((event) => event.eventType === 'operation.review_result');
  if (completed) {
    const saved = z
      .object({ evidence: AssessmentReviewEvidence, digest: z.string() })
      .safeParse(completed.payload);
    if (saved.success && canonicalHash(saved.data.evidence) === saved.data.digest) {
      return { state: 'saved', evidence: saved.data.evidence } as const;
    }
    return { state: 'unknown_result' } as const;
  }
  return events.some((event) => event.eventType === 'operation.review_started')
    ? ({ state: 'unknown_result' } as const)
    : ({ state: 'not_started' } as const);
}
