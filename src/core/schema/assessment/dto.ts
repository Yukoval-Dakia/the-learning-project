import { z } from 'zod';
import type { EvaluationRecordT, SubmissionRecordT } from './judgment';
import { SharedMaterialKind } from './materials';
import { LifecycleQualification, PublishDecision } from './publish';
import { ResponseSpec } from './response';
import type { AssessmentIssuanceT, PublishedQuestionRevisionT } from './revision';
import { PublishedQuestionRevision, validateIssuanceBinding } from './revision';

// ====================================================================
// YUK-1046 — 统一评估契约 · 公私 DTO 边界（grounding §7.1）
// ====================================================================
//
// 三个用途、三份 DTO，互不混用；generic revision JSON 【永不】整体透传：
//
//   1. PracticeIssuanceDto（作答期，公开）：题面、共享材料、ResponseSpec、
//      opaque issuance/revision/part/slot/option 身份。无答案键、无私有
//      rubric、无模型执行计划、无未经筛选 metadata —— 不靠 UI 不渲染来保密，
//      而是 strict schema：注入任何私有字段直接 parse 失败。
//
//   2. AssessmentFeedbackDto（评分后）：按 FeedbackVisibilityPolicy 揭示
//      对应解析/评分依据；policy 在发布时定，反馈投影在服务端做。
//
//   3. QuestionBankEditDto（题库编辑）：完整契约视图（含答案键与计划），
//      授权由 route 层负责（后续 lane）。
//
// 先例：PaperQuestionFace 不含 reference（paper-contracts.ts）；本文件把该
// 纪律推广为统一 issuance DTO。

// ---------- 1. practice issuance DTO（公开面） ----------

export const PublicMaterialView = z.object({
  material_id: z.string().min(1),
  kind: SharedMaterialKind,
  asset_id: z.string().min(1),
  caption: z.string().optional(),
  alt_text: z.string().optional(),
});
export type PublicMaterialViewT = z.infer<typeof PublicMaterialView>;

export const PublicQuestionFace = z.object({
  part_id: z.string().min(1),
  question_no: z.string().optional(),
  prompt_md: z.string(),
  material_ids: z.array(z.string().min(1)),
});
export type PublicQuestionFaceT = z.infer<typeof PublicQuestionFace>;

/**
 * 严格对象：任何未声明键（answer_key / rubric / execution_plan / metadata…）
 * 注入即 parse 失败 —— 公私边界是 schema 契约，不是渲染约定。
 */
export const PracticeIssuanceDto = z.strictObject({
  issuance_id: z.string().min(1),
  revision_id: z.string().min(1),
  issued_at: z.string().datetime(),
  faces: z.array(PublicQuestionFace).min(1),
  materials: z.array(PublicMaterialView),
  response_spec: ResponseSpec,
});
export type PracticeIssuanceDtoT = z.infer<typeof PracticeIssuanceDto>;

/**
 * 纯投影：published revision + issuance → 公开作答 DTO。只从公开字段构造；
 * scoring_basis / execution_plan / 私有 metadata 无从进入。
 *
 * P1-2/P1-6：fail-closed —— 绑定必须先过 validateIssuanceBinding（revision
 * 一致、材料同 digest、选择槽顺序为声明选项的排列），否则抛错，绝不
 * 静默回退到 revision 原状。投影反映【冻结的呈现】：选项按 binding 的
 * option_order 重排（默认 = 声明顺序，不 shuffle）；slots 只包含发出
 * part 范围内的槽位。
 */
export function projectPracticeIssuance(
  revision: PublishedQuestionRevisionT,
  issuance: AssessmentIssuanceT,
): PracticeIssuanceDtoT {
  const bindingIssues = validateIssuanceBinding(issuance.binding, revision);
  if (bindingIssues.length > 0) {
    throw new Error(
      `projectPracticeIssuance: invalid issuance binding for issuance '${issuance.issuance_id}': ${bindingIssues
        .map((issue) => `${issue.code}(${issue.detail})`)
        .join('; ')}`,
    );
  }
  const boundParts = new Set(issuance.binding.part_ids);
  const digestByMaterial = new Map(
    issuance.binding.material_bindings.map(
      (binding) => [binding.material_id, binding.asset_digest] as const,
    ),
  );
  const orderById = new Map(
    issuance.binding.option_order.map((entry) => [entry.slot_id, entry.option_ids] as const),
  );
  const applyServedOrder = <T extends { option_id: string }>(options: T[], slotId: string): T[] => {
    const served = orderById.get(slotId);
    if (served == null) return options;
    const byId = new Map(options.map((option) => [option.option_id, option] as const));
    return served.map((optionId) => byId.get(optionId)).filter((o): o is T => o != null);
  };
  return PracticeIssuanceDto.parse({
    issuance_id: issuance.issuance_id,
    revision_id: revision.revision_id,
    issued_at: issuance.issued_at,
    faces: revision.structure.parts
      .filter((part) => boundParts.has(part.part_id))
      .map((part) => ({
        part_id: part.part_id,
        question_no: part.question_no,
        prompt_md: part.prompt_md,
        material_ids: part.material_ids,
      })),
    materials: revision.structure.materials
      // 只发 issuance 实际绑定（同 digest）的材料 —— 学生所见即判分所引。
      .filter((material) => digestByMaterial.get(material.material_id) === material.asset.digest)
      .map((material) => ({
        material_id: material.material_id,
        kind: material.kind,
        asset_id: material.asset.asset_id,
        caption: material.caption,
        alt_text: material.alt_text,
      })),
    response_spec: {
      slots: revision.response_spec.slots
        // P1-6：只投影发出 part 范围内的槽位；选项按冻结顺序呈现。
        .filter((slot) => boundParts.has(slot.part_id))
        .map((slot) => {
          if (slot.kind === 'single_choice' || slot.kind === 'multi_choice') {
            return { ...slot, options: applyServedOrder(slot.options, slot.slot_id) };
          }
          if (slot.kind === 'matching') {
            return { ...slot, right_options: applyServedOrder(slot.right_options, slot.slot_id) };
          }
          return slot;
        }),
    },
  });
}

// ---------- 2. 评分后 feedback DTO（按可见性 policy 揭示） ----------

/** 发布时定夺、评分后执行的四档可见性。 */
export const FeedbackVisibilityPolicy = z.object({
  reveal_total_score: z.boolean(),
  reveal_unit_breakdown: z.boolean(),
  reveal_answer_keys: z.boolean(),
  reveal_rubric_explanations: z.boolean(),
});
export type FeedbackVisibilityPolicyT = z.infer<typeof FeedbackVisibilityPolicy>;

/**
 * 答案键的公开呈现（揭示时才存在；形态镜像 criterion 的键材料）。
 * P1-3：答案键只揭示【键身份/键值】—— rule_id 与档位 id+rank；
 * 规则原文与档位描述符是私有 rubric，只在 reveal_rubric_explanations
 * 下出现（answer-key 开、rubric 关时不得泄漏 statement/descriptor）。
 */
export const RevealedAnswerKey = z.discriminatedUnion('criterion_kind', [
  z.object({
    scoring_unit_id: z.string().min(1),
    criterion_kind: z.literal('option_set_key'),
    accepted_option_ids: z.array(z.string().min(1)),
  }),
  z.object({
    scoring_unit_id: z.string().min(1),
    criterion_kind: z.literal('matching_pairs_key'),
    accepted_pairs: z.array(z.object({ item_id: z.string().min(1), option_id: z.string().min(1) })),
  }),
  z.object({
    scoring_unit_id: z.string().min(1),
    criterion_kind: z.literal('text_key'),
    accepted_texts: z.array(z.string().min(1)),
  }),
  z.object({
    scoring_unit_id: z.string().min(1),
    criterion_kind: z.literal('numeric_key'),
    expected: z.number(),
    expected_unit: z.string().min(1).optional(),
  }),
  z.object({
    scoring_unit_id: z.string().min(1),
    criterion_kind: z.literal('rule_reference'),
    rule_id: z.string().min(1),
  }),
  z.object({
    scoring_unit_id: z.string().min(1),
    criterion_kind: z.literal('holistic_level'),
    levels: z.array(z.object({ level_id: z.string().min(1), rank: z.number().int().min(0) })),
  }),
]);
export type RevealedAnswerKeyT = z.infer<typeof RevealedAnswerKey>;

/** 评分依据的公开呈现（规则原文/档位描述符；不含内部执行参数）。 */
export const RevealedRubricExplanation = z.object({
  scoring_unit_id: z.string().min(1),
  explanation_md: z.string().min(1),
});
export type RevealedRubricExplanationT = z.infer<typeof RevealedRubricExplanation>;

export const FeedbackUnitResultView = z.object({
  scoring_unit_id: z.string().min(1),
  status: z.enum(['scored', 'pending']),
  /** holistic 单元在未揭示/未解析时可为 null（分数由发布映射解析）。 */
  points_awarded: z.number().min(0).nullable().optional(),
  scored_because: z.enum(['response', 'blank_marked_zero']).optional(),
  pending_reason: z.string().optional(),
});
export type FeedbackUnitResultViewT = z.infer<typeof FeedbackUnitResultView>;

export const AssessmentFeedbackDto = z.strictObject({
  submission_id: z.string().min(1),
  revision_id: z.string().min(1),
  evaluation_id: z.string().min(1),
  /** pending：尚未评出 —— 反馈体不携带任何分数/键/依据。 */
  status: z.enum(['pending', 'completed']),
  aggregate: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('points_total'), points: z.number() }),
      z.object({
        kind: z.literal('level'),
        level_id: z.string().min(1),
        points: z.number().nullable(),
      }),
      z.object({ kind: z.literal('unresolved'), reason: z.string() }),
    ])
    .nullable(),
  unit_results: z.array(FeedbackUnitResultView),
  answer_keys: z.array(RevealedAnswerKey),
  rubric_explanations: z.array(RevealedRubricExplanation),
});
export type AssessmentFeedbackDtoT = z.infer<typeof AssessmentFeedbackDto>;

function revealAnswerKey(
  unit: PublishedQuestionRevisionT['scoring_basis']['units'][number],
): RevealedAnswerKeyT | null {
  const criterion = unit.criterion;
  switch (criterion.kind) {
    case 'option_set_key':
      return {
        scoring_unit_id: unit.scoring_unit_id,
        criterion_kind: 'option_set_key',
        accepted_option_ids: criterion.accepted_option_ids,
      };
    case 'matching_pairs_key':
      return {
        scoring_unit_id: unit.scoring_unit_id,
        criterion_kind: 'matching_pairs_key',
        accepted_pairs: criterion.accepted_pairs,
      };
    case 'text_key':
      return {
        scoring_unit_id: unit.scoring_unit_id,
        criterion_kind: 'text_key',
        accepted_texts: criterion.accepted_texts,
      };
    case 'numeric_key':
      return {
        scoring_unit_id: unit.scoring_unit_id,
        criterion_kind: 'numeric_key',
        expected: criterion.expected,
        expected_unit: criterion.expected_unit,
      };
    case 'rule_reference':
      // P1-3：答案键只给 rule_id（身份）；statement_md 是 rubric，另门揭示。
      return {
        scoring_unit_id: unit.scoring_unit_id,
        criterion_kind: 'rule_reference',
        rule_id: criterion.rule_id,
      };
    case 'holistic_level':
      // P1-3：只给档位身份与次序；descriptor_md 是 rubric，另门揭示。
      return {
        scoring_unit_id: unit.scoring_unit_id,
        criterion_kind: 'holistic_level',
        levels: criterion.levels.map((level) => ({
          level_id: level.level_id,
          rank: level.rank,
        })),
      };
  }
}

function revealRubricExplanation(
  unit: PublishedQuestionRevisionT['scoring_basis']['units'][number],
): RevealedRubricExplanationT | null {
  const criterion = unit.criterion;
  if (criterion.kind === 'rule_reference') {
    return {
      scoring_unit_id: unit.scoring_unit_id,
      explanation_md: criterion.statement_md,
    };
  }
  if (criterion.kind === 'holistic_level') {
    return {
      scoring_unit_id: unit.scoring_unit_id,
      explanation_md: criterion.levels
        .map((level) => `${level.level_id}: ${level.descriptor_md}`)
        .join('\n'),
    };
  }
  return null;
}

/**
 * 纯投影：评分记录 + 可见性 policy → 反馈 DTO。
 * P2-3 语义说明：未揭示的维度以【显式无内容】呈现 —— aggregate:null、
 * 数组为空 —— 字段本身始终存在（strict schema 固定形状）；“未揭示”与
 * “揭示后确实为空”的区分由 status + 对应 flag 消费方判定，不靠缺键。
 * pending 评估只回身份与状态，任何 flag 都不产生内容。
 */
export function projectFeedback(
  submission: SubmissionRecordT,
  evaluation: EvaluationRecordT,
  revision: PublishedQuestionRevisionT,
  policy: FeedbackVisibilityPolicyT,
): AssessmentFeedbackDtoT {
  const pending = evaluation.status !== 'completed';
  const aggregate =
    !pending && policy.reveal_total_score && evaluation.aggregate != null
      ? evaluation.aggregate.kind === 'points_total'
        ? { kind: 'points_total' as const, points: evaluation.aggregate.points }
        : evaluation.aggregate.kind === 'level'
          ? {
              kind: 'level' as const,
              level_id: evaluation.aggregate.level_id,
              points: evaluation.aggregate.points,
            }
          : { kind: 'unresolved' as const, reason: evaluation.aggregate.reason }
      : null;

  const unitResults: FeedbackUnitResultViewT[] =
    !pending && policy.reveal_unit_breakdown
      ? evaluation.unit_results.map((result) =>
          result.status === 'scored'
            ? {
                scoring_unit_id: result.scoring_unit_id,
                status: 'scored' as const,
                points_awarded: result.points_awarded,
                scored_because: result.scored_because,
              }
            : {
                scoring_unit_id: result.scoring_unit_id,
                status: 'pending' as const,
                pending_reason: result.pending.reason,
              },
        )
      : [];

  const answerKeys: RevealedAnswerKeyT[] =
    !pending && policy.reveal_answer_keys
      ? revision.scoring_basis.units
          .map(revealAnswerKey)
          .filter((key): key is RevealedAnswerKeyT => key !== null)
      : [];

  const rubricExplanations: RevealedRubricExplanationT[] =
    !pending && policy.reveal_rubric_explanations
      ? revision.scoring_basis.units
          .map(revealRubricExplanation)
          .filter((item): item is RevealedRubricExplanationT => item !== null)
      : [];

  return AssessmentFeedbackDto.parse({
    submission_id: submission.submission_id,
    revision_id: submission.revision_id,
    evaluation_id: evaluation.evaluation_id,
    status: pending ? 'pending' : 'completed',
    aggregate,
    unit_results: unitResults,
    answer_keys: answerKeys,
    rubric_explanations: rubricExplanations,
  });
}

// ---------- 3. 题库编辑 DTO（编辑面；含答案键） ----------

export const QuestionBankEditDto = z.object({
  revision: PublishedQuestionRevision,
  lifecycle: LifecycleQualification,
  publish_decision: PublishDecision,
});
export type QuestionBankEditDtoT = z.infer<typeof QuestionBankEditDto>;
