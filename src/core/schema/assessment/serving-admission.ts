import { unit as parseUnit } from 'mathjs';
import { EvaluationContractError, projectIssuedScoringBasis } from './evaluation';
import { validateExecutionPlan } from './execution';
import { isPublicSharedMaterial } from './materials';
import type { ResponseSlotT } from './response';
import type { PublishedQuestionRevisionT } from './revision';
import { type ScoringUnitT, validateScoringBasis } from './scoring';

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

// ---------- YUK-1496 C2 — 模型准入切片（服务门只读视图） ----------

/** 模型可判的响应类（设计 §4 准入门第 4 步：科目/响应类/任务/模型版本切片）。 */
export type ModelResponseClass = 'blank' | 'free';

/**
 * 已准入切片（行真相在 model_admission_slice 表；这是服务门的纯读面）。
 * holdout_evidence_ref 指向留出题实测证据（逐题一致性 + severe error 记录）。
 */
export interface AdmittedModelSliceT {
  readonly slice_id: string;
  readonly subject: string;
  readonly response_class: ModelResponseClass;
  readonly task_kind: string;
  readonly model: string;
  readonly model_version: string;
  readonly holdout_evidence_ref: string;
  readonly admitted_at: string;
  readonly admitted_by: string;
}

/**
 * 服务门的模型准入上下文：由调用方从权威登记处解析后传入（门本身保持纯函数，
 * 不读 DB）。slices 只含 active 切片；current_models 是各 task_kind 当前实际
 * 会执行的模型 + 版本 pin —— 切片登记的模型与当前 pin 漂移即不再准入。
 */
export interface ModelAdmissionContext {
  readonly slices: ReadonlyMap<string, AdmittedModelSliceT>;
  readonly current_models: ReadonlyMap<string, { model: string; model_version: string }>;
}

/** unit 判据 → 响应类；确定性判据不由模型判（返回 null，模型分支 fail-closed）。 */
export function modelResponseClassForUnit(unit: ScoringUnitT): ModelResponseClass | null {
  switch (unit.criterion.kind) {
    case 'blank_key':
      return 'blank';
    case 'rubric':
    case 'rule_reference':
    case 'holistic_level':
      return 'free';
    default:
      return null;
  }
}

/**
 * 模型单元准入判定（纯函数）：admitted_slice_id 必须解析到一个 active 切片，
 * 且切片的 task kind / 响应类 / 模型版本与本次执行一致。上下文缺省 = 登记处
 * 未接线，全部模型单元扣留（YUK-1496 C2 之前的行为）。
 */
function checkModelUnitAdmission(
  unit: ScoringUnitT,
  executor: Extract<
    PublishedQuestionRevisionT['execution_plan']['assignments'][number]['executor'],
    { kind: 'model_executor' }
  >,
  admission: ModelAdmissionContext | undefined,
): string | null {
  if (executor.admitted_slice_id === null) {
    return `model_executor slice unadmitted (task ${executor.task_kind})`;
  }
  if (admission === undefined) {
    return `no authoritative model admission for task ${executor.task_kind}, slice ${executor.admitted_slice_id}`;
  }
  const slice = admission.slices.get(executor.admitted_slice_id);
  if (slice === undefined) {
    return `admitted_slice_id '${executor.admitted_slice_id}' does not resolve to an active slice`;
  }
  if (slice.task_kind !== executor.task_kind) {
    return `slice '${slice.slice_id}' is admitted for task '${slice.task_kind}', not '${executor.task_kind}'`;
  }
  const responseClass = modelResponseClassForUnit(unit);
  if (responseClass === null) {
    return `criterion '${unit.criterion.kind}' is deterministic-comparator territory, not model-servable`;
  }
  if (slice.response_class !== responseClass) {
    return `slice '${slice.slice_id}' covers response class '${slice.response_class}', not '${responseClass}'`;
  }
  const pin = admission.current_models.get(executor.task_kind);
  if (pin === undefined) {
    return `no current model pin for task '${executor.task_kind}'`;
  }
  if (pin.model !== slice.model || pin.model_version !== slice.model_version) {
    return `slice '${slice.slice_id}' was admitted for ${slice.model}@${slice.model_version}; current pin is ${pin.model}@${pin.model_version} — re-admission required`;
  }
  return null;
}

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
  admission?: ModelAdmissionContext,
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
      // YUK-1496 C2：模型单元只在 admitted_slice_id 解析到 active 切片且
      // task kind / 响应类 / 模型版本三者一致时放行；登记处未接线（无
      // admission 上下文）时维持旧行为 —— 全部扣留，绝不发明准入。
      const admissionIssue = checkModelUnitAdmission(unit, executor, admission);
      if (admissionIssue !== null) {
        return {
          kind: 'unavailable',
          reason: 'model_admission_unavailable',
          detail: admissionIssue,
        };
      }
      continue;
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
