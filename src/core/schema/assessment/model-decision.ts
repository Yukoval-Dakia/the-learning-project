import { z } from 'zod';
import { ConjectureProbeSignatureMatch } from '../conjecture-probe-response';
import { EvidenceCitation } from './judgment';

// Models report a published rule decision or a published level. They never
// return aggregation weights, new criteria, a normalized coarse score or FSRS ratings.
const support = {
  confidence: z.number().min(0).max(1),
  feedback_md: z.string(),
  evidence_citations: z.array(EvidenceCitation).min(1),
};
export const AssessmentRuleDecision = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rule'),
      rule_id: z.string().min(1),
      points_awarded: z.number().min(0),
      probe_signature_match: ConjectureProbeSignatureMatch.optional(),
      ...support,
    })
    .strict(),
  z.object({ kind: z.literal('level'), level_id: z.string().min(1), ...support }).strict(),
  z
    .object({
      kind: z.literal('pending'),
      detail: z.string().min(1),
      evidence_citations: z
        .array(
          EvidenceCitation.strict().refine(
            (citation) => citation.slot_id !== undefined || citation.evidence_id !== undefined,
            'A pending citation must identify a slot or evidence attachment',
          ),
        )
        .optional(),
    })
    .strict(),
]);
export type AssessmentRuleDecisionT = z.infer<typeof AssessmentRuleDecision>;

// --------------------------------------------------------------------
// YUK-1496 — AI rubric（统一设计 §3 free 段 / 附录 A5）
// --------------------------------------------------------------------

/**
 * 评分细则判定契约的当前版本。写入已准入切片的 model_version（模型 + 版本
 * 匹配才放行，见 serving-admission.ts 的 model 分支）；改动 rubric 判定
 * 提示词/输出契约必须同时 bump 此版本 —— 旧切片随之失效，需重新准入。
 */
export const ASSESSMENT_RUBRIC_PROMPT_REVISION = 'assessment-rubric-prompt-v1' as const;

/**
 * AI rubric 决策：模型逐项返回 criterion award + 理由 + 证据引用（作答原文
 * 引用或已送达图片的 evidence_id）。契约里没有总分字段 —— 代码按发布时
 * 冻结的 allowed_awards 校验并求和；模型不得新增 criterion、修改满分或
 * 自报一个不一致的总分。没真实收到原图时不得声称读了图（执行器把未送达
 * 证据的引用直接判 invalid）。
 */
export const AssessmentRubricDecision = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('awards'),
      awards: z
        .array(
          z
            .object({
              criterion_id: z.string().min(1),
              award: z.number().min(0),
              reason: z.string().min(1),
              evidence_citations: z.array(EvidenceCitation).min(1),
            })
            .strict(),
        )
        .min(1),
      confidence: z.number().min(0).max(1).optional(),
      feedback_md: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pending'),
      detail: z.string().min(1),
      evidence_citations: z
        .array(
          EvidenceCitation.strict().refine(
            (citation) => citation.slot_id !== undefined || citation.evidence_id !== undefined,
            'A pending citation must identify a slot or evidence attachment',
          ),
        )
        .optional(),
    })
    .strict(),
]);
export type AssessmentRubricDecisionT = z.infer<typeof AssessmentRubricDecision>;
