// YUK-1052 — issueAssessment / saveSubmission / 自动保存的 API 契约（wire 层）。
// request/response zod 形状直接复用 core/schema/assessment 的契约类型 —
// wire 不发明第二套载荷；ResponseSet/GroupEvidence/PracticeIssuanceDto 原样透传。

import { z } from 'zod';

import { GroupEvidence, PracticeIssuanceDto, ResponseSet } from '@/core/schema/assessment';

// ---------- 发题（issueAssessment） ----------

export const IssueAssessmentBodySchema = z.object({
  /** 客户端可选幂等锚；缺省服务端生成。 */
  issuance_id: z.string().min(1).optional(),
  /** 组根 question id。 */
  group_id: z.string().min(1),
  /** 显式目标 revision（缺省 = current_revision_id；必须属于该组，否则 409）。 */
  revision_id: z.string().min(1).optional(),
  /** 目标 part 子集（缺省 = 全部）。 */
  part_ids: z.array(z.string().min(1)).min(1).optional(),
  /** 选择槽呈现顺序覆盖（必须是声明选项的排列；缺省 = 声明顺序不 shuffle）。 */
  option_order_overrides: z.record(z.string(), z.array(z.string().min(1))).optional(),
  /** 'auto_score'（默认，要求 admitted）| 'manual'（D9 显式手动练习）。 */
  mode: z.enum(['auto_score', 'manual']).default('auto_score'),
  /** container_only 组必填。 */
  container_occurrence_ref: z.string().min(1).nullable().optional(),
  /** 请求一次性占用（one_time claim）。 */
  claim: z.object({ claimed_by_ref: z.string().min(1) }).optional(),
});

export const IssuanceClaimSchema = z.object({
  policy: z.enum(['one_time', 'unbounded']),
  status: z.enum(['unclaimed', 'claimed', 'released']),
  claimed_by_ref: z.string().nullable(),
});

export const AssessmentIssuanceSchema = z.object({
  issuance_id: z.string().min(1),
  revision_id: z.string().min(1),
  part_ids: z.array(z.string().min(1)),
  material_bindings: z.array(
    z.object({ material_id: z.string().min(1), asset_digest: z.string().min(1) }),
  ),
  option_order: z.array(
    z.object({ slot_id: z.string().min(1), option_ids: z.array(z.string().min(1)) }),
  ),
  container_occurrence_ref: z.string().nullable(),
  claim: IssuanceClaimSchema,
  issued_at: z.string(),
});

export const IssuanceCreatedSchema = z.object({
  status: z.enum(['issued', 'replayed']),
  issuance: AssessmentIssuanceSchema,
  /** 作答期公开 DTO（无答案键/私有 rubric/执行计划 —— §7.1 公私边界）。 */
  practice_dto: PracticeIssuanceDto,
  /** 发题时观测到的 admission generation（激活 CAS 用）。 */
  admission_generation_observed: z.number().int().nullable(),
});

// ---------- 自动保存草稿（D11：saving/saved/error 仅服务端 ack） ----------

export const SaveResponseDraftBodySchema = z.object({
  /** 草稿声明的联合判分组锚点（paper 联判共享；null/缺省 = 未定组）。 */
  evaluation_group_ref: z.string().min(1).nullable().optional(),
  response_set: ResponseSet,
  group_evidence: z.array(GroupEvidence).default([]),
  /** stale 防线：上次 ack 的 save_epoch；落后于服务端 ⇒ 409。 */
  expected_save_epoch: z.number().int().min(0).optional(),
});

export const SaveResponseDraftResponseSchema = z.object({
  status: z.literal('saved'),
  issuance_id: z.string().min(1),
  save_epoch: z.number().int(),
  updated_at: z.string(),
});

export const ResponseDraftSchema = z.object({
  evaluation_group_ref: z.string().nullable(),
  response_set: ResponseSet,
  group_evidence: z.array(GroupEvidence),
  save_epoch: z.number().int(),
  updated_at: z.string(),
});

// ---------- 正式提交（saveSubmission） ----------

export const CreateSubmissionBodySchema = z.object({
  issuance_id: z.string().min(1),
  /** 客户端可选幂等锚；缺省服务端生成。 */
  submission_id: z.string().min(1).optional(),
  evaluation_group_id: z.string().min(1),
  /** 幂等键：同 (group,key) 重复提交 —— 一致 replay；不同 conflict(409)。 */
  idempotency_key: z.string().min(1),
  response_set: ResponseSet,
  group_evidence: z.array(GroupEvidence).default([]),
});

export const SubmissionRecordSchema = z.object({
  submission_id: z.string().min(1),
  issuance_id: z.string().min(1),
  revision_id: z.string().min(1),
  evaluation_group_id: z.string().min(1),
  response_set: ResponseSet,
  group_evidence: z.array(GroupEvidence),
  idempotency_key: z.string().min(1),
  submitted_at: z.string(),
});

export const SubmissionCreatedSchema = z.object({
  status: z.enum(['saved', 'replayed']),
  submission: SubmissionRecordSchema,
  /** 提交绑定的不可变坐标（冻结在 issuance 行 —— 不回取 latest）。 */
  revision_id: z.string().min(1),
  issuance_id: z.string().min(1),
});

// ---------- 发题状态快照（pending 恢复读面） ----------

export const IssuanceStateSchema = z.object({
  issuance: AssessmentIssuanceSchema.nullable(),
  /** 最新 live draft；null = 服务端无未保存草稿（恢复 promise 的真相源）。 */
  draft: ResponseDraftSchema.nullable(),
  /** 本 issuance 已接收的提交。 */
  submissions: z.array(
    z.object({
      submission_id: z.string().min(1),
      evaluation_group_id: z.string().min(1),
      submitted_at: z.string(),
    }),
  ),
});

export const IssuanceParamsSchema = z.object({ id: z.string().min(1) });
