// ====================================================================
// YUK-1496 C2 — 模型判分准入切片登记处（统一设计 §4 准入门第 4 步、
// ADR-0073 D2 模型级准入、stage1 G3「已准入判分切片，出题门能认」）
// ====================================================================
//
// 权威记录 = model_admission_slice 表（migration 0122）。本模块提供：
//   - resolveModelAdmissionContext：服务门读面 —— active 切片 + 当前模型
//     pin，供 decideAutomaticServing 的 model 分支（纯函数）消费；
//   - registerModelAdmissionSlice：显式注册（admin/worker），携带留出题实测
//     证据引用。没有任何自动准入路径；dry run 不落行；
//   - retireModelAdmissionSlice：显式退役（行保留，status 翻转）。
//
// 模型 pin：切片准入时钉 (model, model_version)；当前 pin 由 task registry
// 的 defaultModel + 各 lane 的契约版本构成 —— typed Jev 是 canonical 响应
// 模型，chat rubric 是 prompt 模板修订。pin 漂移 ⇒ 旧切片不再放行（服务门
// model 分支拒绝），必须重跑留出题重新准入。

import { and, eq, inArray, or } from 'drizzle-orm';
import { type TaskKind, tasks } from '@/capabilities/task-registry';
import { canonicalHash } from '@/core/migration/canonical';
import { ASSESSMENT_RUBRIC_PROMPT_REVISION } from '@/core/schema/assessment/model-decision';
import type {
  AdmittedModelSliceT,
  ModelAdmissionContext,
  ModelResponseClass,
} from '@/core/schema/assessment/serving-admission';
import type { Db, Tx } from '@/db/client';
import { model_admission_slice, question } from '@/db/schema';
import { batchResolveEffectiveDomains } from '@/kernel/read-models/knowledge-tree';
import { JEV_CANONICAL_MODEL } from '@/server/ai/pricing';
import { resolveConfiguredTaskModel } from '@/server/ai/providers';
import { resolveSubjectProfile } from '@/subjects/profile';

type SliceRow = typeof model_admission_slice.$inferSelect;

/**
 * 各可准入 task kind 的当前契约版本 pin。模型 id 不在这里写死：它必须是
 * resolveConfiguredTaskModel 将要执行的那个 id（registry 默认、task.<kind>.model、
 * 全局开关、chat env pin 同一层）。版本轴仍由本表钉住。
 */
const CURRENT_MODEL_VERSION_PINS: Readonly<Record<string, string>> = {
  // typed lane：canonical 响应模型即版本（wire drift = contract violation）。
  JevScoringDecisionTask: JEV_CANONICAL_MODEL,
  // chat lane：评分细则判定 prompt/输出契约修订（model-decision.ts）。
  AssessmentRubricJudgeTask: ASSESSMENT_RUBRIC_PROMPT_REVISION,
};

/** 当前每个可准入 task kind 实际会执行的 (model, model_version)。 */
export function currentModelPins(): ReadonlyMap<string, { model: string; model_version: string }> {
  const pins = new Map<string, { model: string; model_version: string }>();
  for (const [kind, version] of Object.entries(CURRENT_MODEL_VERSION_PINS)) {
    const definition = tasks[kind as TaskKind];
    if (definition === undefined) continue;
    pins.set(kind, { model: resolveConfiguredTaskModel(kind as TaskKind), model_version: version });
  }
  return pins;
}

function rowToSlice(row: SliceRow): AdmittedModelSliceT {
  return {
    slice_id: row.slice_id,
    subject: row.subject,
    response_class: row.response_class,
    task_kind: row.task_kind,
    model: row.model,
    model_version: row.model_version,
    holdout_evidence_ref: row.holdout_evidence_ref,
    admitted_at: row.admitted_at.toISOString(),
    admitted_by: row.admitted_by,
  };
}

/** 服务门读面：全部 active 切片 + 当前模型 pin。只读，无副作用。 */
export async function resolveModelAdmissionContext(db: Db | Tx): Promise<ModelAdmissionContext> {
  const rows = await db
    .select()
    .from(model_admission_slice)
    .where(eq(model_admission_slice.status, 'active'));
  return {
    slices: new Map(rows.map((row) => [row.slice_id, rowToSlice(row)])),
    current_models: currentModelPins(),
  };
}

/**
 * 切片身份 = 自然键五字段的内容寻址。只哈希这五字段：证据引用、登记人和
 * 时间不参与身份，否则登记处存下的 slice_id 与 job 报告的 id 不是同一个，
 * 引用报告 id 的题会被扣留，付费前预检也找不到已有行。
 */
export function modelSliceIdFor(input: {
  subject: string;
  response_class: ModelResponseClass;
  task_kind: string;
  model: string;
  model_version: string;
}): string {
  const identity = {
    subject: input.subject,
    response_class: input.response_class,
    task_kind: input.task_kind,
    model: input.model,
    model_version: input.model_version,
  };
  return `slice_${canonicalHash(identity).slice(0, 32)}`;
}

/** 根题 → 学科。与留出题 job 同一座桥：knowledge_ids[0] → effective domain → subject id。 */
export type GroupSubjectLookup =
  | { readonly kind: 'subject'; readonly subject: string }
  | { readonly kind: 'missing_group' }
  | { readonly kind: 'unlabeled' }
  | { readonly kind: 'no_domain'; readonly knowledge_id: string };

export async function lookupGroupSubjects(
  db: Db | Tx,
  groupIds: readonly string[],
): Promise<Map<string, GroupSubjectLookup>> {
  const unique = [...new Set(groupIds)];
  const out = new Map<string, GroupSubjectLookup>();
  if (unique.length === 0) return out;
  const rows = await db
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(inArray(question.id, unique));
  const knowledgeByGroup = new Map(rows.map((row) => [row.id, row.knowledge_ids[0] ?? null]));
  const domains = await batchResolveEffectiveDomains(db, [
    ...new Set([...knowledgeByGroup.values()].filter((id): id is string => id !== null)),
  ]);
  for (const groupId of unique) {
    if (!knowledgeByGroup.has(groupId)) {
      out.set(groupId, { kind: 'missing_group' });
      continue;
    }
    const knowledgeId = knowledgeByGroup.get(groupId) ?? null;
    if (knowledgeId === null) {
      out.set(groupId, { kind: 'unlabeled' });
      continue;
    }
    const domain = domains.get(knowledgeId) ?? null;
    if (domain === null) {
      out.set(groupId, { kind: 'no_domain', knowledge_id: knowledgeId });
      continue;
    }
    out.set(groupId, { kind: 'subject', subject: resolveSubjectProfile(domain).id });
  }
  return out;
}

const RETIRED_SLICE_DETAIL = (sliceId: string) =>
  `slice '${sliceId}' is retired for this model pin; retirement is permanent for the natural key, and a different model version is a different slice`;

/** postgres.js 把 23505 包在 cause 链上；走到唯一约束就认。 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function findSliceByIdentity(
  db: Db | Tx,
  input: {
    subject: string;
    response_class: ModelResponseClass;
    task_kind: string;
    model: string;
    model_version: string;
  },
): Promise<SliceRow | undefined> {
  const sliceId = modelSliceIdFor(input);
  const [existing] = await db
    .select()
    .from(model_admission_slice)
    .where(
      or(
        eq(model_admission_slice.slice_id, sliceId),
        and(
          eq(model_admission_slice.subject, input.subject),
          eq(model_admission_slice.response_class, input.response_class),
          eq(model_admission_slice.task_kind, input.task_kind),
          eq(model_admission_slice.model, input.model),
          eq(model_admission_slice.model_version, input.model_version),
        ),
      ),
    )
    .limit(1);
  return existing;
}

export class ModelSliceRegistrationError extends Error {
  override name = 'ModelSliceRegistrationError';
  constructor(
    public readonly code:
      | 'unknown_task_kind'
      | 'model_pin_mismatch'
      | 'slice_conflict'
      | 'slice_retired',
    detail: string,
  ) {
    super(`registerModelAdmissionSlice: ${code} — ${detail}`);
  }
}

export interface RegisterModelAdmissionSliceInput {
  readonly subject: string;
  readonly response_class: ModelResponseClass;
  readonly task_kind: string;
  readonly model: string;
  readonly model_version: string;
  /** 留出题实测证据引用（逐题 agreement / severe error 记录）。 */
  readonly holdout_evidence_ref: string;
  readonly admitted_by: string;
  readonly admitted_at?: Date;
}

/**
 * 付费前置栅栏（YUK-1496 R1）：在留出题付费循环开始【之前】预检切片行 ——
 * 登记处会拒绝的状态（已退役、同 slice_id 不同证据/actor）当场抛错，绝不
 * 让 ~30 次付费调用跑完才在登记处爆掉、被队列重跑整段付费循环。幂等可
 * 登记的既有行（同证据 + 同 actor）或尚不存在的新切片静默通过。
 */
export async function assertModelAdmissionSliceRegistrable(
  db: Db | Tx,
  input: RegisterModelAdmissionSliceInput,
): Promise<void> {
  const sliceId = modelSliceIdFor(input);
  const existing = await findSliceByIdentity(db, input);
  if (existing === undefined) return;
  if (existing.status === 'retired') {
    throw new ModelSliceRegistrationError('slice_retired', RETIRED_SLICE_DETAIL(sliceId));
  }
  if (
    existing.holdout_evidence_ref !== input.holdout_evidence_ref ||
    existing.admitted_by !== input.admitted_by
  ) {
    throw new ModelSliceRegistrationError(
      'slice_conflict',
      `slice '${sliceId}' already exists with different evidence/actor`,
    );
  }
}

/**
 * 显式注册一个已准入切片。准入前校验：task kind 必须有当前 pin（即它是已
 * 注册的判分任务），且登记的 (model, model_version) 与当前 pin 完全一致 ——
 * 不给「准入一个现在不会执行的模型」留门。同自然键已 active 且载荷一致 ⇒
 * 幂等返回既有行；同 slice_id 但载荷不同 ⇒ 冲突；已退役 ⇒ 拒绝复活（重新
 * 准入走新证据，不覆盖史实）。
 */
export async function registerModelAdmissionSlice(
  db: Db | Tx,
  input: RegisterModelAdmissionSliceInput,
): Promise<AdmittedModelSliceT> {
  const pin = currentModelPins().get(input.task_kind);
  if (pin === undefined) {
    throw new ModelSliceRegistrationError(
      'unknown_task_kind',
      `task kind '${input.task_kind}' has no current model pin — only registered grading tasks are admissible`,
    );
  }
  if (pin.model !== input.model || pin.model_version !== input.model_version) {
    throw new ModelSliceRegistrationError(
      'model_pin_mismatch',
      `slice claims ${input.model}@${input.model_version} but the current pin is ${pin.model}@${pin.model_version}`,
    );
  }
  const sliceId = modelSliceIdFor(input);
  const existing = await findSliceByIdentity(db, input);
  if (existing !== undefined) {
    if (existing.status === 'retired') {
      throw new ModelSliceRegistrationError('slice_retired', RETIRED_SLICE_DETAIL(sliceId));
    }
    if (
      existing.holdout_evidence_ref === input.holdout_evidence_ref &&
      existing.admitted_by === input.admitted_by
    ) {
      return rowToSlice(existing);
    }
    throw new ModelSliceRegistrationError(
      'slice_conflict',
      `slice '${sliceId}' already exists with different evidence/actor`,
    );
  }
  const admittedAt = input.admitted_at ?? new Date();
  try {
    await db.insert(model_admission_slice).values({
      slice_id: sliceId,
      subject: input.subject,
      response_class: input.response_class,
      task_kind: input.task_kind,
      model: input.model,
      model_version: input.model_version,
      holdout_evidence_ref: input.holdout_evidence_ref,
      admitted_by: input.admitted_by,
      admitted_at: admittedAt,
      status: 'active',
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ModelSliceRegistrationError(
        'slice_conflict',
        `slice '${sliceId}' already exists for this model pin`,
      );
    }
    throw error;
  }
  return rowToSlice({
    slice_id: sliceId,
    subject: input.subject,
    response_class: input.response_class,
    task_kind: input.task_kind,
    model: input.model,
    model_version: input.model_version,
    holdout_evidence_ref: input.holdout_evidence_ref,
    admitted_by: input.admitted_by,
    admitted_at: admittedAt,
    status: 'active',
  });
}

/** 显式退役：行保留（准入史实），status 翻转后服务门立即不再放行。 */
export async function retireModelAdmissionSlice(
  db: Db | Tx,
  sliceId: string,
): Promise<'retired' | 'not_found'> {
  const updated = await db
    .update(model_admission_slice)
    .set({ status: 'retired' })
    .where(
      and(eq(model_admission_slice.slice_id, sliceId), eq(model_admission_slice.status, 'active')),
    )
    .returning({ slice_id: model_admission_slice.slice_id });
  return updated.length > 0 ? 'retired' : 'not_found';
}
