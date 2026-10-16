import { unit as parseUnit } from 'mathjs';
import { EvaluationContractError, projectIssuedScoringBasis } from './evaluation';
import { validateExecutionPlan } from './execution';
import { isPublicSharedMaterial } from './materials';
import type { ResponseSlotT } from './response';
import type { PublishedQuestionRevisionT } from './revision';
import { validateScoringBasis } from './scoring';

/** YUK-1445 —— typed withheld reasons（公共读面安全枚举；detail 只作内部诊断）。
 * 单一来源：wire schema / DTO 共用此 tuple，禁止第二份拷贝。 */
export const SERVING_UNAVAILABLE_REASONS = [
  'invalid_scoring_contract',
  'invalid_execution_plan',
  'invalid_issuance_scope',
  'unprojectable_aggregation',
  'no_scoring_units',
  'human_review',
  'model_admission_unavailable',
  'unsupported_deterministic_input',
  'missing_referenced_figure',
  'no_input_renderer',
] as const;
export type ServingUnavailableReason = (typeof SERVING_UNAVAILABLE_REASONS)[number];

export type AutomaticServingDecision =
  | { kind: 'admitted' }
  | {
      kind: 'unavailable';
      reason: ServingUnavailableReason;
      detail: string;
    };

/**
 * 网页作答面已有输入控件的槽位种类（YUK-1496）。没有控件的题后端判得了也不发，
 * 避免「题出了却没有输入框」。界面线落地某类输入积木时在同一 PR 把它加进来。
 */
export const INPUT_RENDERER_SLOT_KINDS: ReadonlySet<ResponseSlotT['kind']> = new Set([
  'single_choice',
  'multi_choice',
  'text',
  'numeric',
  'formula',
  'matching',
  'ordering',
  'open_response',
]);

/** Read-only capability check on the frozen plan, never a publication or model admission. */
export function decideAutomaticServing(
  revision: PublishedQuestionRevisionT,
  selectedPartIds: readonly string[],
): AutomaticServingDecision {
  const scoringIssues = validateScoringBasis(
    revision.scoring_basis,
    revision.response_spec,
    revision.structure,
  );
  if (scoringIssues.length > 0) {
    return {
      kind: 'unavailable',
      reason: 'invalid_scoring_contract',
      detail: scoringIssues.map((issue) => `${issue.code}: ${issue.detail}`).join('; '),
    };
  }
  // Structural errors in a frozen plan remain errors. Model admission is checked only
  // for selected units, so an unrelated human/model part cannot withhold a valid subset.
  const planIssues = validateExecutionPlan(revision.execution_plan, revision.scoring_basis).filter(
    (issue) => issue.code !== 'unadmitted_model_executor',
  );
  if (planIssues.length > 0) {
    return {
      kind: 'unavailable',
      reason: 'invalid_execution_plan',
      detail: planIssues.map((issue) => `${issue.code}: ${issue.detail}`).join('; '),
    };
  }
  let basis: PublishedQuestionRevisionT['scoring_basis'];
  try {
    basis = projectIssuedScoringBasis(revision, selectedPartIds);
  } catch (error) {
    if (!(error instanceof EvaluationContractError)) throw error;
    return {
      kind: 'unavailable',
      reason:
        error.code === 'unprojectable_aggregation'
          ? 'unprojectable_aggregation'
          : 'invalid_issuance_scope',
      detail: error.message,
    };
  }
  if (basis.units.length === 0) {
    return {
      kind: 'unavailable',
      reason: 'no_scoring_units',
      detail: 'selected parts have no scoring units',
    };
  }
  const selected = new Set(selectedPartIds);
  const answerSlots = revision.response_spec.slots.filter(
    (slot) => selected.has(slot.part_id) && slot.kind !== 'table',
  );
  const unrenderable = answerSlots.find((slot) => !INPUT_RENDERER_SLOT_KINDS.has(slot.kind));
  if (unrenderable != null) {
    return {
      kind: 'unavailable',
      reason: 'no_input_renderer',
      detail: `slot ${unrenderable.slot_id} (${unrenderable.kind}) has no learner input control yet`,
    };
  }
  if (
    answerSlots.some((slot) => !basis.units.some((unit) => unit.slot_refs.includes(slot.slot_id)))
  ) {
    return {
      kind: 'unavailable',
      reason: 'invalid_scoring_contract',
      detail: 'a selected answer slot has no scoring unit',
    };
  }
  for (const unit of basis.units) {
    const executor = revision.execution_plan.assignments.find((assignment) =>
      assignment.scoring_unit_ids.includes(unit.scoring_unit_id),
    )?.executor;
    // validateExecutionPlan has already proved unique coverage.
    if (executor == null) {
      return {
        kind: 'unavailable',
        reason: 'invalid_execution_plan',
        detail: `no executor for ${unit.scoring_unit_id}`,
      };
    }
    if (executor.kind === 'human_review') {
      return {
        kind: 'unavailable',
        reason: 'human_review',
        detail: `unit ${unit.scoring_unit_id} requires human review`,
      };
    }
    if (executor.kind === 'model_executor') {
      // Production has typed Jev/Pi runners but no authoritative slice-to-task/
      // criterion admission registry. A nonnull string is not execution authority.
      // Keep existing evaluation/recovery checks; do not invent serving admission.
      return {
        kind: 'unavailable',
        reason: 'model_admission_unavailable',
        detail: `no authoritative model admission for task ${executor.task_kind}, slice ${executor.admitted_slice_id ?? 'null'}`,
      };
    }
    const slots = revision.response_spec.slots.filter(
      (slot) => selected.has(slot.part_id) && unit.slot_refs.includes(slot.slot_id),
    );
    // The real deterministic runner reads one primary answer slot, not arbitrary
    // attachment/group evidence or a joint response assembled from several slots.
    if (
      slots.length !== 1 ||
      unit.slot_refs.length !== 1 ||
      unit.evidence_slot_refs.length > 0 ||
      unit.requires_group_evidence
    ) {
      return {
        kind: 'unavailable',
        reason: 'unsupported_deterministic_input',
        detail: `unit ${unit.scoring_unit_id} does not have one supported primary answer slot`,
      };
    }
    const slot = slots[0];
    if (
      slot.kind === 'open_response' &&
      (slot.evidence_required || slot.accepted_evidence.length > 0)
    ) {
      return {
        kind: 'unavailable',
        reason: 'unsupported_deterministic_input',
        detail: `unit ${unit.scoring_unit_id} declares evidence the comparator cannot consume`,
      };
    }
    if (
      executor.comparator === 'numeric_unit_conversion' &&
      unit.criterion.kind === 'numeric_key'
    ) {
      try {
        parseUnit(1, unit.criterion.expected_unit);
      } catch {
        return {
          kind: 'unavailable',
          reason: 'unsupported_deterministic_input',
          detail: `unit ${unit.scoring_unit_id} has an unsupported reference unit`,
        };
      }
    }
  }
  // YUK-1445 —— 题面/公开共享材料显式依赖图（如图/下图/图中…）而 part 未绑定
  // 任何【实内容核验过的】figure 材料 ⇒ 题面对学习者不可解，不可出。unverified
  // digest 不算真实绑定（其资产内容未知）。executor 检查先行：冻结计划本身不能
  // 判分是更根本的不可用原因。
  const materialById = new Map(
    revision.structure.materials.map((material) => [material.material_id, material]),
  );
  const verifiedFigureIds = new Set(
    revision.structure.materials
      .filter(
        (material) =>
          material.kind === 'figure' &&
          isPublicSharedMaterial(material) &&
          !material.asset.digest.startsWith('unverified:'),
      )
      .map((material) => material.material_id),
  );
  for (const part of revision.structure.parts) {
    if (!selected.has(part.part_id)) continue;
    const surfaces = [part.prompt_md];
    for (const materialId of part.material_ids) {
      const material = materialById.get(materialId);
      if (material && isPublicSharedMaterial(material) && material.content_md)
        surfaces.push(material.content_md);
    }
    if (!FIGURE_REFERENCE_RE.test(surfaces.join('\n'))) continue;
    if (part.material_ids.some((materialId) => verifiedFigureIds.has(materialId))) continue;
    return {
      kind: 'unavailable',
      reason: 'missing_referenced_figure',
      detail: `part ${part.part_id} references a figure in its learner-facing surface but no verified figure material is bound`,
    };
  }
  return { kind: 'admitted' };
}

/** 题面对图的显式引用标记（生产方题面惯例）。 */
const FIGURE_REFERENCE_RE = /如图|见图|下图|右图|左图|上图|图中|图所示/;
