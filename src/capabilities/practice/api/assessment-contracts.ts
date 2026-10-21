// issueAssessment / saveSubmission / 自动保存的 wire 契约。
// 形状直接复用 core/schema/assessment —— wire 不发明第二套载荷。

import { z } from 'zod';

import {
  AssessmentIssuance,
  GroupEvidence,
  PracticeIssuanceDto,
  ResponseSet,
} from '@/core/schema/assessment';
import { SERVING_UNAVAILABLE_REASONS } from '@/core/schema/assessment/serving-admission';

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

// wire schema 直接复用 core AssessmentIssuance：handler 返回的
// AssessmentIssuanceT 把冻结坐标嵌套在 `issuance.binding` 下（且不含
// container_occurrence_ref）；另造平铺 schema 会让生成客户端读不到真字段。
export const AssessmentIssuanceSchema = AssessmentIssuance;

export const IssuanceCreatedSchema = z.object({
  status: z.enum(['issued', 'replayed']),
  issuance: AssessmentIssuanceSchema,
  /** 作答期公开 DTO（无答案键、私有 rubric、执行计划）。 */
  practice_dto: PracticeIssuanceDto,
  /** 发题时观测到的 admission generation（激活 CAS 用）。 */
  admission_generation_observed: z.number().int().nullable(),
});

/**
 * 学习者网页提交的作答集：`state:'unknown'`（看不清）只由
 * 作答卷/拍照回收产生，网页作答面不能自称看不清。回收侧直接调领域写入器，
 * 不经这两个 HTTP 入口。
 */
const LearnerResponseSet = ResponseSet.refine(
  (set) =>
    set.entries.every(
      (entry) => (entry.kind !== 'select' && entry.kind !== 'blank') || entry.state !== 'unknown',
    ),
  { message: "state 'unknown' is reserved for worksheet/photo capture" },
);

// ---------- 自动保存草稿 ----------

export const SaveResponseDraftBodySchema = z.object({
  /** 草稿声明的联合判分组锚点（paper 联判共享；null/缺省 = 未定组）。 */
  evaluation_group_ref: z.string().min(1).nullable().optional(),
  response_set: LearnerResponseSet,
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
  response_set: LearnerResponseSet,
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
  /** 恢复快照补回作答期公开 DTO（由 issuance 冻结绑定 + pinned revision 重建）。 */
  practice_dto: PracticeIssuanceDto.nullable(),
  /** practice_dto 被 serving gate 收回时的 typed 原因（公共枚举；
   * 诊断 detail 不透出）。有已接收提交 ⇒ null。 */
  unavailable_reason: z.enum(SERVING_UNAVAILABLE_REASONS).nullable(),
  /** 发题时观测到的 admission generation（恢复后激活 CAS 的锚点；未知 = null）。 */
  admission_generation_observed: z.number().int().nullable(),
  /** 最新 live draft；null = 服务端无未保存草稿（恢复 promise 的真相源）。 */
  draft: ResponseDraftSchema.nullable(),
  /** 本 issuance 已接收的提交。 */
  submissions: z.array(
    z.object({
      submission_id: z.string().min(1),
      evaluation_group_id: z.string().min(1),
      submitted_at: z.string(),
      idempotency_key: z.string(),
      response_set: ResponseSet,
      group_evidence: z.array(GroupEvidence),
    }),
  ),
});

export const IssuanceParamsSchema = z.object({ id: z.string().min(1) });
export const StudyReferenceResponseSchema = z.object({ reference_md: z.string().nullable() });
