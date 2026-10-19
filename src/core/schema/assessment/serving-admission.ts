import { unit as parseUnit } from 'mathjs';
import {
  DECLARED_BLANK_COMPARE_VERSION,
  declaredBlankGradeReadiness,
} from './blank-answer-compare';
import { EvaluationContractError, projectIssuedScoringBasis } from './evaluation';
import { validateExecutionPlan } from './execution';
import { isPublicSharedMaterial } from './materials';
import {
  Presentation,
  type PresentationBlockT,
  type PresentationT,
  validatePresentation,
} from './presentation';
import type { ResponseSlotT } from './response';
import type { PublishedQuestionRevisionT } from './revision';
import { type ScoringUnitT, validateScoringBasis } from './scoring';
import { NATIVE_FIELD_SLOT_KIND_SET } from './slot-renderers';

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
  'invalid_presentation',
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

/**
 * 判据 → 可服务它的已准入判分 task kinds（与执行器能力精确对齐：rubric
 * 执行器只判 rubric 判据；Jev typed 线判 rule/level/blank 等价；pi rule 线
 * 判 rule/level。task kind 字面量镜像 model-slice-registry 的
 * CURRENT_MODEL_VERSION_PINS —— 只有登记了 pin 的 task kind 才可能有已准入
 * 切片）。切片判给不能服务该判据的 task ⇒ 服务门扣留，绝不放行后永远 pending。
 */
const MODEL_TASK_KINDS_BY_CRITERION: Readonly<Record<string, readonly string[]>> = {
  rubric: ['AssessmentRubricJudgeTask'],
  blank_key: ['JevScoringDecisionTask'],
  rule_reference: ['JevScoringDecisionTask', 'AssessmentRuleJudgeTask'],
  holistic_level: ['JevScoringDecisionTask', 'AssessmentRuleJudgeTask'],
};

/**
 * unit 的响应类由其引用的【作答槽位】决定（K1 统一作答：blank 槽 → 'blank'，
 * open_response 槽 → 'free'），不由 criterion kind 反推 —— 判据与响应类是两个
 * 轴，同一判据可挂不同形态的槽。引用槽缺失、为空、混合或旧形态 ⇒ null
 * （fail-closed，模型分支不放行）。
 */
export function modelResponseClassForUnit(
  unit: ScoringUnitT,
  slots: readonly ResponseSlotT[],
): ModelResponseClass | null {
  if (unit.slot_refs.length === 0) return null;
  const slotById = new Map(slots.map((slot) => [slot.slot_id, slot]));
  let responseClass: ModelResponseClass | null = null;
  for (const slotId of unit.slot_refs) {
    const slot = slotById.get(slotId);
    if (slot === undefined) return null;
    const slotClass =
      slot.kind === 'blank' ? 'blank' : slot.kind === 'open_response' ? 'free' : null;
    if (slotClass === null || (responseClass !== null && responseClass !== slotClass)) {
      return null;
    }
    responseClass = slotClass;
  }
  return responseClass;
}

/**
 * 模型单元准入判定（纯函数）：admitted_slice_id 必须解析到一个 active 切片，
 * 且切片的 task kind 能服务该判据、响应类与本次执行一致、模型版本与当前
 * pin 一致。上下文缺省 = 登记处未接线，全部模型单元扣留（YUK-1496 C2 之前
 * 的行为）。
 */
function checkModelUnitAdmission(
  unit: ScoringUnitT,
  executor: Extract<
    PublishedQuestionRevisionT['execution_plan']['assignments'][number]['executor'],
    { kind: 'model_executor' }
  >,
  admission: ModelAdmissionContext | undefined,
  slots: readonly ResponseSlotT[],
  questionSubject: string | null | undefined,
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
  if (questionSubject == null || slice.subject !== questionSubject) {
    return `slice '${slice.slice_id}' is admitted for subject '${slice.subject}', not '${questionSubject ?? 'unresolved'}'`;
  }
  if (slice.task_kind !== executor.task_kind) {
    return `slice '${slice.slice_id}' is admitted for task '${slice.task_kind}', not '${executor.task_kind}'`;
  }
  // 判据 ↔ task kind：一个判给不能服务该判据的 task 的切片必须扣留 ——
  // 放行只会让执行器永远 pending（rubric 执行器拒非 rubric 判据、Jev 拒
  // rubric 判据），那是个静默黑洞，不是准入。
  const expectedTaskKinds = MODEL_TASK_KINDS_BY_CRITERION[unit.criterion.kind];
  if (expectedTaskKinds === undefined) {
    return `criterion '${unit.criterion.kind}' is deterministic-comparator territory, not model-servable`;
  }
  if (!expectedTaskKinds.includes(executor.task_kind)) {
    return `criterion '${unit.criterion.kind}' is not servable by task '${executor.task_kind}' (expected ${expectedTaskKinds.join(' | ')}) — withheld instead of pending forever`;
  }
  if (unit.criterion.kind === 'blank_key') {
    const key = unit.criterion.key;
    if (key.kind !== 'text' || key.equivalence === undefined) {
      return `blank_key unit '${unit.scoring_unit_id}' is not Jev-expressible — only a text key with a declared equivalence domain can be model-served`;
    }
  }
  const responseClass = modelResponseClassForUnit(unit, slots);
  if (responseClass === null) {
    return `unit '${unit.scoring_unit_id}' derives no coherent model response class from its answer slots (uniform blank or open_response required)`;
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
 * 网页逐槽渲染已有输入控件的槽位种类（YUK-1496）。没有控件的题后端判得了也不发，
 * 避免「题出了却没有输入框」。只能由展示层积木画出的种类见 BLOCK_INPUT_SLOT_KINDS。
 * 清单单一来源在 slot-renderers.ts（YUK-1573），与 nativeSlotFieldSpec 编译期绑定。
 */
export const INPUT_RENDERER_SLOT_KINDS: ReadonlySet<ResponseSlotT['kind']> =
  NATIVE_FIELD_SLOT_KIND_SET;

/**
 * YUK-1497 —— 只能由展示层输入积木画出的槽位种类（spec §4）：没有逐槽控件，
 * 只有 revision 的 presentation 用声明式输入积木绑定它时才可出。
 */
const BLOCK_INPUT_SLOT_KINDS: ReadonlySet<ResponseSlotT['kind']> = new Set(['select', 'blank']);

/** 每个被绑定槽位由谁画：声明式输入积木，或网页尚不能运行的自定义块。 */
function presentationBinders(presentation: PresentationT): Map<string, 'block' | 'custom'> {
  const out = new Map<string, 'block' | 'custom'>();
  const walk = (block: PresentationBlockT): void => {
    switch (block.kind) {
      case 'stack':
      case 'passage_layout':
        for (const child of block.children) walk(child);
        return;
      case 'text_math':
      case 'figure':
        return;
      case 'custom':
        for (const bind of block.binds) out.set(bind.slot_id, 'custom');
        return;
      default:
        out.set(block.bind.slot_id, 'block');
    }
  };
  walk(presentation.root);
  return out;
}

/** Read-only capability check on the frozen plan, never a publication or model admission. */
export function decideAutomaticServing(
  revision: PublishedQuestionRevisionT,
  selectedPartIds: readonly string[],
  admission?: ModelAdmissionContext,
  questionSubject?: string | null,
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
  // YUK-1568（第 2 片）：发出范围内的已声明 blank 槽现在由共享比较核心判定
  // 判分就绪（声明被支持 + 被 blank_key unit 读取 + 私有键可编译）。任一缺
  // 项（未知版本、未实现 notation、键冲突、缺判分单元）仍明确拒绝发题，
  // 绝不回退普通 exact 文本判分。此闸在渲染面检查之前：判不了分比画不出
  // 更根本。
  const declaredReadiness = declaredBlankGradeReadiness(
    revision.response_spec,
    revision.scoring_basis,
    selectedPartIds,
  );
  if (!declaredReadiness.ok) {
    return {
      kind: 'unavailable',
      reason: 'unsupported_deterministic_input',
      detail: `declared answer_shape not gradable: ${declaredReadiness.reason} (comparator ${DECLARED_BLANK_COMPARE_VERSION})`,
    };
  }
  // YUK-1497 —— 展示层形状门先行（review R1）：行读面（revisionRowToContract）对解析
  // 失败的展示层原样透传而非丢列（丢列 = 静默降级为逐槽渲染的 fail-open）；这里以
  // invalid_presentation 拒绝，绝不带着坏展示层发题，原因也不被输入面检查盖住。
  const shapedPresentation =
    revision.presentation != null ? Presentation.safeParse(revision.presentation) : null;
  if (shapedPresentation != null && !shapedPresentation.success) {
    return {
      kind: 'unavailable',
      reason: 'invalid_presentation',
      detail: `malformed presentation: ${shapedPresentation.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}:${issue.message}`)
        .join('; ')}`,
    };
  }
  // 有展示层时网页按积木树作答：select/blank 只有被声明式输入积木绑定才有输入面；
  // 自定义块（沙箱）网页尚不能运行，被它绑定的槽一律没有输入面。
  // YUK-1497：网页沙箱渲染器已在（practice/ui/blocks/CustomBlock.tsx），但这里继续扣发，
  // 直到后端准入预演（YUK-1513）完成；届时放行条件为「渲染器在 + digest 是 sha256: 而非 unverified:」。
  const binders = shapedPresentation?.success
    ? presentationBinders(shapedPresentation.data)
    : new Map<string, 'block' | 'custom'>();
  const unrenderable = answerSlots.find((slot) => {
    const binder = binders.get(slot.slot_id);
    if (binder === 'custom') return true;
    if (BLOCK_INPUT_SLOT_KINDS.has(slot.kind)) return binder !== 'block';
    return !INPUT_RENDERER_SLOT_KINDS.has(slot.kind);
  });
  if (unrenderable != null) {
    return {
      kind: 'unavailable',
      reason: 'no_input_renderer',
      detail:
        binders.get(unrenderable.slot_id) === 'custom'
          ? `slot ${unrenderable.slot_id} (${unrenderable.kind}) is bound by a custom block the web cannot run yet`
          : BLOCK_INPUT_SLOT_KINDS.has(unrenderable.kind)
            ? `slot ${unrenderable.slot_id} (${unrenderable.kind}) is not bound by a presentation input block`
            : `slot ${unrenderable.slot_id} (${unrenderable.kind}) has no learner input control yet`,
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
  // YUK-1497 —— 冻结展示层对发出范围校验失败 ⇒ 不可出（发布 barrier 已拒
  // 全量不合格，这里抓剪枝后缺口（如自定义块跨发出/未发出 part）与被绕过
  // barrier 写入的行）。无展示层的旧 revision 不受影响。
  if (shapedPresentation?.success) {
    const presentationIssues = validatePresentation(
      shapedPresentation.data,
      revision.structure,
      revision.response_spec,
      revision.scoring_basis,
      selectedPartIds,
    );
    if (presentationIssues.length > 0) {
      return {
        kind: 'unavailable',
        reason: 'invalid_presentation',
        detail: presentationIssues.map((issue) => `${issue.code}: ${issue.detail}`).join('; '),
      };
    }
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
      // task kind 能服务该判据、响应类 / 模型版本一致时放行；登记处未接线
      // （无 admission 上下文）时维持旧行为 —— 全部扣留，绝不发明准入。
      const admissionIssue = checkModelUnitAdmission(
        unit,
        executor,
        admission,
        revision.response_spec.slots,
        questionSubject,
      );
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
