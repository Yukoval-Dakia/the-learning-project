// System grading admission uses frozen reference-model comparisons, never gold labels.
import { eq, inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { type TaskKind, resolveTaskBudget } from '@/capabilities/task-registry';
import { assessmentRubricInvocationWindowMs } from '@/core/assessment-rubric-timeout';
import { canonicalHash } from '@/core/migration/canonical';
import {
  GroupEvidence,
  type ModelExecutorRequest,
  type ModelUnitOutcomeT,
  type PendingStateT,
  QuestionGroupStructure,
  QuestionPart,
  ResponseSlot,
  ScoringBasis,
  ScoringUnit,
  SharedMaterial,
  SlotResponse,
  modelResponseClassForUnit,
} from '@/core/schema/assessment';
import type { ModelOutcomeDiagnosticsT } from '@/core/schema/assessment/model-diagnostics';
import { sha256Canonical } from '@/core/task-input-hash';
import type { Db } from '@/db/client';
import { ai_task_runs, event, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { withModelSliceAdmissionLock } from '@/kernel/locks/grading';
import { lookupGroupSubjects } from '@/kernel/read-models/model-admission';
import { resolveTaskBinding } from '@/server/ai/providers';
import { currentTaskSpendScope } from '@/server/ai/task-spend-scope';
import { createAdmissionRunExecutor } from '../server/judge/evaluate-submission';
import {
  assertModelAdmissionSliceRegistrable,
  currentModelPinForKind,
  modelSliceIdFor,
  registerModelAdmissionSlice,
} from '../server/model-slice-registry';

/**
 * Existing blank-response policy. Free responses use the fixed four-class bars below.
 */
export const MODEL_SLICE_ADMISSION_THRESHOLDS = {
  min_items: 30,
  min_agreement_ratio: 0.9,
  max_severe_errors: 0,
} as const;

/**
 * Free-response holdout 允许的显式 pending 上限：每 120 项 3 条，更大留出集按
 * 比例 floor。pending 不算对也不算错，但超出上限说明候选没有给出可对照的完整
 * 有分输出，不登记。与三条硬线同为常量，调用方不可放宽。
 *
 * 只有模型调用真实完成、收到回应、费用已结算的 pending 才计入此线 ——
 * 以定夺 attempt（run_refs 末位）落账 `status='success'` 且全部引用 run
 * 费用 resolved 为准；超时、取消、provider 失败、无账可对的 pending 与
 * 未尝试/缺项/scored 无分不受此线保护，仍按完整性一律拦。
 */
const FREE_HOLDOUT_MAX_PENDING_PER_120 = 3;

/** 同一数值口径：卷面十进制分值的二进制表示误差不当差异（与发布校验同律）。 */
function samePoints(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** 细则留出题的墙钟含一次超时重试；其他 task kind 仍是单次 budget.timeout。 */
export function admissionCallWindowMs(taskKind: string, timeoutMs: number): number {
  return taskKind === 'AssessmentRubricJudgeTask'
    ? assessmentRubricInvocationWindowMs(timeoutMs)
    : timeoutMs;
}

export function holdoutItemFromOutcome(
  item: { item_id: string; reference_points: number; unit_points: number | null },
  outcome: ModelUnitOutcomeT,
): ModelSliceAdmissionItemResult {
  if (outcome.kind !== 'scored') {
    return {
      item_id: item.item_id,
      status: 'pending',
      awarded_points: null,
      reference_points: item.reference_points,
      agreed: false,
      severe_error: false,
      pending_reason: outcome.pending.reason,
      pending: outcome.pending,
      ...(outcome.diagnostics !== undefined ? { diagnostics: outcome.diagnostics } : {}),
      run_refs: outcome.run_refs,
      ...(outcome.cost_usd_micros !== undefined
        ? { cost_usd_micros: outcome.cost_usd_micros }
        : {}),
    };
  }
  const awarded = outcome.points_awarded;
  const unitMax = item.unit_points;
  const agreed = awarded !== null && samePoints(awarded, item.reference_points);
  const severe =
    awarded !== null &&
    unitMax !== null &&
    (awarded > unitMax ||
      (item.reference_points === 0 && awarded > 0) ||
      (samePoints(item.reference_points, unitMax) && awarded === 0));
  return {
    item_id: item.item_id,
    status: 'scored',
    awarded_points: awarded,
    reference_points: item.reference_points,
    agreed,
    severe_error: severe,
    run_refs: outcome.run_refs,
    ...(outcome.cost_usd_micros !== undefined ? { cost_usd_micros: outcome.cost_usd_micros } : {}),
  };
}

export function holdoutRunTally(results: readonly ModelSliceAdmissionItemResult[]): {
  items: number;
  agreed: number;
  agreement_ratio: number;
  severe_errors: number;
  known_cost_usd_micros: number;
  unknown_cost_items: number;
} {
  let known = 0;
  let unknown = 0;
  let agreed = 0;
  let severe = 0;
  for (const result of results) {
    if (result.agreed) agreed += 1;
    if (result.severe_error) severe += 1;
    if (result.cost_usd_micros !== undefined) known += result.cost_usd_micros;
    else unknown += 1;
  }
  return {
    items: results.length,
    agreed,
    agreement_ratio: results.length === 0 ? 0 : agreed / results.length,
    severe_errors: severe,
    known_cost_usd_micros: known,
    unknown_cost_items: unknown,
  };
}

function assertFrozenUnit(
  itemId: string,
  revisionId: string,
  unit: z.infer<typeof ScoringUnit>,
  scoringBasis: unknown,
): void {
  const parsed = ScoringBasis.safeParse(scoringBasis);
  if (!parsed.success) {
    throw new Error(
      `model_slice_admission_run: item '${itemId}' revision '${revisionId}' has no readable frozen scoring basis`,
    );
  }
  const frozen = parsed.data.units.find(
    (candidate) => candidate.scoring_unit_id === unit.scoring_unit_id,
  );
  if (frozen === undefined) {
    throw new Error(
      `model_slice_admission_run: item '${itemId}' unit '${unit.scoring_unit_id}' is not in the frozen scoring basis of revision '${revisionId}'`,
    );
  }
  if (canonicalHash(unit) !== canonicalHash(frozen)) {
    throw new Error(
      `model_slice_admission_run: item '${itemId}' unit '${unit.scoring_unit_id}' does not match the frozen scoring basis of revision '${revisionId}'`,
    );
  }
}

function assertFrozenQuestionParts(
  itemId: string,
  revisionId: string,
  parts: ReadonlyArray<z.infer<typeof QuestionPart>>,
  structure: unknown,
): void {
  const parsed = QuestionGroupStructure.safeParse(structure);
  if (!parsed.success) {
    throw new Error(
      `model_slice_admission_run: item '${itemId}' revision '${revisionId}' has no readable frozen question structure`,
    );
  }
  const frozenById = new Map(parsed.data.parts.map((part) => [part.part_id, part] as const));
  if (parts.length !== frozenById.size) {
    throw new Error(
      `model_slice_admission_run: item '${itemId}' cites ${parts.length} question parts but revision '${revisionId}' freezes ${frozenById.size}`,
    );
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part.part_id)) {
      throw new Error(
        `model_slice_admission_run: item '${itemId}' repeats question part '${part.part_id}'`,
      );
    }
    seen.add(part.part_id);
    const frozen = frozenById.get(part.part_id);
    if (frozen === undefined) {
      throw new Error(
        `model_slice_admission_run: item '${itemId}' part '${part.part_id}' is not in the frozen question stem of revision '${revisionId}'`,
      );
    }
    if (canonicalHash(QuestionPart.parse(part)) !== canonicalHash(frozen)) {
      throw new Error(
        `model_slice_admission_run: item '${itemId}' part '${part.part_id}' does not match the frozen question stem of revision '${revisionId}'`,
      );
    }
  }
}

const HoldoutItem = z
  .object({
    item_id: z.string().min(1),
    revision_id: z.string().min(1),
    /** 冻结的计分单元（criterion + rule + points）。 */
    unit: ScoringUnit,
    question_parts: z.array(QuestionPart),
    response_slots: z.array(ResponseSlot),
    slot_responses: z.array(SlotResponse),
    group_evidence: z.array(GroupEvidence).default([]),
    materials: z.array(SharedMaterial).default([]),
    /** 独立参考分（不是模型产出；留出题带独立标定）。 */
    reference_points: z.number().min(0),
    answer_class: z.enum(['correct', 'equivalent', 'wrong', 'partial']).optional(),
    class_reason: z.string().min(1).optional(),
  })
  .strict();

const ModelSliceAdmissionRunData = z
  .object({
    /** 调用方钉的幂等身份（事件 id 锚；重投不重写证据、不重复准入）。 */
    run_id: z.string().min(1),
    comparison_role: z.enum(['candidate', 'reference']).default('candidate'),
    reference_run_id: z.string().min(1).optional(),
    slice: z
      .object({
        response_class: z.enum(['blank', 'free']),
        task_kind: z.string().min(1),
        model: z.string().min(1),
        model_version: z.string().min(1),
      })
      .strict(),
    /**
     * 冻结证明：必须等于 `sha256:${canonicalHash(调用方给出的 items)}`。
     * 哈希的是解析前的数组，zod 补上的 group_evidence / materials 默认值不进 digest。
     */
    holdout_digest: z.string().min(1),
    items: z.array(HoldoutItem).min(1),
    per_item_max_cost_usd_micros: z.number().int().min(1),
    total_max_cost_usd_micros: z.number().int().min(1).max(3_000_000).default(3_000_000),
    /** dry run 只出证据，绝不登记准入。 */
    dry_run: z.boolean().default(false),
    admitted_by: z.string().min(1),
  })
  .strict();
export type ModelSliceAdmissionRunDataT = z.infer<typeof ModelSliceAdmissionRunData>;

export interface ModelSliceAdmissionItemResult {
  item_id: string;
  status: 'scored' | 'pending';
  awarded_points: number | null;
  reference_points: number;
  agreed: boolean;
  severe_error: boolean;
  pending_reason?: string;
  /** 完整未决态（detail / retryable / trigger 等）；pending_reason 只是它的索引。 */
  pending?: PendingStateT;
  /** 执行期拒收诊断（枚举/数量/hash/已提交 id；不含学习者或模型明文）。 */
  diagnostics?: ModelOutcomeDiagnosticsT;
  /**
   * pending 是否计入 FREE_HOLDOUT_MAX_PENDING_PER_120：定夺 attempt
   * （run_refs 末位）落账 success 且全部引用 run 费用 resolved 才为 true；
   * 超时/取消/provider 失败/无账可对的 pending 为 false，按完整性一律拦。
   */
  model_call_completed?: boolean;
  /**
   * 定夺 attempt（run_refs 末位）的 canonical 输入 digest（ai_task_runs.input_hash）
   * 与定夺 outcome 的 canonical digest。ai_task_runs.result_digest 只有 typed
   * seal 消费方写，本 lane 恒 null —— 输出绑定由本 job 实算 outcome 承载。
   * 无 run（预算门在付费前拒）时 input_digest 为 null；null 本身是证据，不补造。
   */
  input_digest?: string | null;
  output_digest?: string | null;
  actual_runs?: Array<{
    id: string;
    provider: string;
    model: string;
    status: string;
    cost_basis: string | null;
    cost_usd: number | null;
    input_hash: string;
    result_digest: string | null;
    error_message: string | null;
  }>;
  run_refs: string[];
  cost_usd_micros?: number;
}

export interface ModelSliceAdmissionRunSummary {
  run_id: string;
  slice_id: string;
  passed: boolean;
  dry_run: boolean;
  admitted: boolean;
  evidence_event_id: string;
  items: number;
  agreed: number;
  agreement_ratio: number;
  severe_errors: number;
  known_cost_usd_micros: number;
  /** 费用未知的题数（unknown 保持 unknown，不估数）。 */
  unknown_cost_items: number;
  failures: string[];
}

/**
 * 同一切片已有留出题占着会话锁。这不是登记冲突：不付费、不写证据、不抛。
 * 抛出会让 llm 队列把 job 记成 failed 并重试，而且 slice_conflict 会把
 * 「别人正在跑」说成「切片已经登记过」。
 */
export interface ModelSliceAdmissionLockBusy {
  outcome: 'lock_busy';
  run_id: string;
  slice_id: string;
  passed: false;
  dry_run: boolean;
  admitted: false;
  failures: ['lock_busy'];
}

export type ModelSliceAdmissionRunResult =
  | ModelSliceAdmissionRunSummary
  | ModelSliceAdmissionLockBusy;

function rawHoldoutItems(rawData: unknown): unknown {
  if (rawData !== null && typeof rawData === 'object' && 'items' in rawData) {
    return (rawData as { items: unknown }).items;
  }
  return undefined;
}

const StoredAdmissionPayload = z
  .object({
    request_digest: z.string().optional(),
    dry_run: z.boolean(),
    items: z.array(z.object({ agreed: z.boolean() }).passthrough()),
    agreement_ratio: z.number(),
    severe_errors: z.number().int(),
    known_cost_usd_micros: z.number(),
    unknown_cost_items: z.number().int(),
    failures: z.array(z.string()),
  })
  .passthrough();

async function readAdmissionEvidence(
  db: Db,
  evidenceEventId: string,
): Promise<{ outcome: string | null; payload: unknown } | null> {
  const [row] = await db
    .select({ outcome: event.outcome, payload: event.payload })
    .from(event)
    .where(eq(event.id, evidenceEventId))
    .limit(1);
  return row ?? null;
}

async function referenceComparisonReady(db: Db, raw: unknown): Promise<boolean> {
  const candidate = z
    .object({
      comparison_role: z.literal('candidate'),
      reference_run_id: z.string(),
      holdout_digest: z.string(),
      items: z.array(z.object({ item_id: z.string() }).passthrough()),
    })
    .safeParse(raw);
  if (!candidate.success) return false;
  const reference = await readAdmissionEvidence(
    db,
    `evt_model_slice_admission_${candidate.data.reference_run_id}`,
  );
  const payload = z
    .object({
      version: z.literal(2),
      comparison_role: z.literal('reference'),
      dry_run: z.literal(true),
      holdout_digest: z.literal(candidate.data.holdout_digest),
      items: z.array(
        z
          .object({
            item_id: z.string(),
            status: z.enum(['scored', 'pending']),
            awarded_points: z.number().nullable(),
            agreed: z.boolean(),
            pending_reason: z.string().min(1).optional(),
          })
          .refine((item) =>
            item.status === 'pending'
              ? item.awarded_points === null && !item.agreed && item.pending_reason !== undefined
              : item.awarded_points !== null,
          ),
      ),
    })
    .safeParse(reference?.payload);
  return (
    // A reference records comparison; disagreement and pending are not a gold threshold.
    payload.success &&
    payload.data.items.length === candidate.data.items.length &&
    new Set(payload.data.items.map((item) => item.item_id)).size === candidate.data.items.length &&
    candidate.data.items.every((item) =>
      payload.data.items.some((result) => result.item_id === item.item_id),
    )
  );
}

async function finishFromStoredEvidence(
  db: Db,
  stored: { outcome: string | null; payload: unknown },
  registrationInput: {
    response_class: 'blank' | 'free';
    task_kind: string;
    model: string;
    model_version: string;
    request_digest: string;
    holdout_evidence_ref: string;
    admitted_by: string;
  },
  sliceId: string,
  evidenceEventId: string,
  runId: string,
): Promise<ModelSliceAdmissionRunSummary> {
  const parsed = StoredAdmissionPayload.safeParse(stored.payload);
  if (!parsed.success) {
    return {
      run_id: runId,
      slice_id: sliceId,
      passed: false,
      dry_run: true,
      admitted: false,
      evidence_event_id: evidenceEventId,
      items: 0,
      agreed: 0,
      agreement_ratio: 0,
      severe_errors: 0,
      known_cost_usd_micros: 0,
      unknown_cost_items: 0,
      failures: [
        'stored evidence for this run_id is unreadable; the run was not repeated and the slice was not admitted',
      ],
    };
  }
  if (
    stored.outcome === 'passed' &&
    parsed.data.request_digest !== registrationInput.request_digest
  ) {
    throw new Error(
      'stored admission evidence does not match the frozen request; use a new run_id',
    );
  }
  const failures = [...parsed.data.failures];
  let admitted = false;
  const referenceReady =
    registrationInput.response_class !== 'free' ||
    (await referenceComparisonReady(db, stored.payload));
  if (stored.outcome === 'passed' && !parsed.data.dry_run && !referenceReady) {
    failures.push('reference comparison record incomplete or mismatched; no slice admitted');
  }
  if (stored.outcome === 'passed' && !parsed.data.dry_run && referenceReady) {
    try {
      await registerModelAdmissionSlice(db, registrationInput);
      admitted = true;
    } catch (error) {
      failures.push(
        `registration refused: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    run_id: runId,
    slice_id: sliceId,
    passed: stored.outcome === 'passed',
    dry_run: parsed.data.dry_run,
    admitted,
    evidence_event_id: evidenceEventId,
    items: parsed.data.items.length,
    agreed: parsed.data.items.filter((item) => item.agreed).length,
    agreement_ratio: parsed.data.agreement_ratio,
    severe_errors: parsed.data.severe_errors,
    known_cost_usd_micros: parsed.data.known_cost_usd_micros,
    unknown_cost_items: parsed.data.unknown_cost_items,
    failures,
  };
}

export async function runModelSliceAdmission(
  db: Db,
  rawData: unknown,
): Promise<ModelSliceAdmissionRunResult> {
  const rawItems = rawHoldoutItems(rawData);
  const data = ModelSliceAdmissionRunData.parse(rawData);
  const failures: string[] = [];

  // 1) 冻结证明：对调用方给出的 items 取哈希，不把 zod 默认值算进去。
  const actualDigest = `sha256:${canonicalHash(rawItems)}`;
  if (actualDigest !== data.holdout_digest) {
    throw new Error(
      `model_slice_admission_run: holdout set is not frozen — digest ${actualDigest} != declared ${data.holdout_digest}`,
    );
  }

  // 2) 切片与当前模型 pin 必须一致：不给「准入一个现在不会执行的模型」留门
  //    （registerModelAdmissionSlice 写前再校验一次，双保险）。
  const pin = currentModelPinForKind(data.slice.task_kind);
  if (pin === undefined) {
    throw new Error(
      `model_slice_admission_run: task kind '${data.slice.task_kind}' is not a registered admissible grading task`,
    );
  }
  if (pin.model !== data.slice.model || pin.model_version !== data.slice.model_version) {
    throw new Error(
      `model_slice_admission_run: slice claims ${data.slice.model}@${data.slice.model_version} but the current pin is ${pin.model}@${pin.model_version}`,
    );
  }
  const expectedRoute = resolveTaskBinding(data.slice.task_kind as TaskKind);
  const sliceId = modelSliceIdFor(data.slice);
  // 证据事件 id 只由 run_id 决定 —— 付费循环前就能算出，供登记预检使用。
  const evidenceEventId = `evt_model_slice_admission_${data.run_id}`;
  const registrationInput = {
    ...data.slice,
    request_digest: canonicalHash(data),
    holdout_evidence_ref: evidenceEventId,
    admitted_by: data.admitted_by,
  };

  // Refuse a retired or conflicting slice before the paid loop. A later refusal is
  // caught and the job returns, so the queue does not rerun those calls.
  await assertModelAdmissionSliceRegistrable(db, registrationInput);

  // 2c) 同一 run_id 的证据已存在就直接复读。先写者赢：失败的证据不能被后来的
  //     同 id 成功跑覆盖成准入，也绝不再付一次费。
  const storedEvidence = await readAdmissionEvidence(db, evidenceEventId);
  if (storedEvidence !== null) {
    return finishFromStoredEvidence(
      db,
      storedEvidence,
      registrationInput,
      sliceId,
      evidenceEventId,
      data.run_id,
    );
  }

  // 3) 留出题集与切片响应类一致 + 规模阈值 + 单元可加性。
  if (data.items.length < MODEL_SLICE_ADMISSION_THRESHOLDS.min_items) {
    throw new Error(
      `model_slice_admission_run: holdout set has ${data.items.length} items < ${MODEL_SLICE_ADMISSION_THRESHOLDS.min_items} (design §4 admission step 4)`,
    );
  }
  for (const item of data.items) {
    const responseClass = modelResponseClassForUnit(item.unit, item.response_slots);
    if (responseClass !== data.slice.response_class) {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' is response class '${responseClass ?? 'non-model'}', not '${data.slice.response_class}' — the holdout set does not match the slice`,
      );
    }
    if (item.unit.points === null) {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' has null unit points — holdout items must be additive units with printed points`,
      );
    }
    if (item.reference_points > item.unit.points) {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' reference ${item.reference_points} exceeds unit max ${item.unit.points}`,
      );
    }
  }

  // Subjects record coverage only; every item still binds its frozen question and rule.
  const revisionRows = await db
    .select({
      revision_id: question_revision.revision_id,
      group_id: question_revision.group_id,
      scoring_basis: question_revision.scoring_basis,
      structure: question_revision.structure,
    })
    .from(question_revision)
    .where(
      inArray(
        question_revision.revision_id,
        data.items.map((item) => item.revision_id),
      ),
    );
  const revisionById = new Map(revisionRows.map((row) => [row.revision_id, row]));
  const subjects = await lookupGroupSubjects(
    db,
    revisionRows.map((row) => row.group_id),
  );
  for (const item of data.items) {
    const revision = revisionById.get(item.revision_id);
    if (revision === undefined) {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' revision '${item.revision_id}' does not exist`,
      );
    }
    const lookup = subjects.get(revision.group_id);
    if (lookup === undefined || lookup.kind === 'missing_group' || lookup.kind === 'unlabeled') {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' root question '${revision.group_id}' has no knowledge labeling — a holdout item's subject cannot be resolved`,
      );
    }
    if (lookup.kind === 'no_domain') {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' knowledge '${lookup.knowledge_id}' has no resolvable effective domain`,
      );
    }
    assertFrozenUnit(item.item_id, item.revision_id, item.unit, revision.scoring_basis);
    assertFrozenQuestionParts(
      item.item_id,
      item.revision_id,
      item.question_parts,
      revision.structure,
    );
  }

  const answerClasses = ['correct', 'equivalent', 'wrong', 'partial'] as const;
  if (new Set(data.items.map((item) => item.item_id)).size !== data.items.length) {
    throw new Error('model_slice_admission_run: duplicate item identity');
  }

  // 4) 占位之后才逐题判分。另一条 run 拿着同一切片的会话锁时，返回
  //    lock_busy，不抛、不付费。锁内再预检一次：对方可能已经登记完。
  const reservedWork = await withModelSliceAdmissionLock(db, sliceId, async () => {
    await assertModelAdmissionSliceRegistrable(db, registrationInput);

    if (data.slice.response_class === 'free') {
      const byQuestion = new Map<string, Set<string>>();
      const questionUnits = new Map<string, string>();
      for (const item of data.items) {
        if (!item.answer_class || !item.class_reason) {
          throw new Error(
            'model_slice_admission_run: free responses require four-class explanations',
          );
        }
        const groupId = revisionById.get(item.revision_id)?.group_id;
        if (!groupId || item.unit.points === null)
          throw new Error('missing frozen question or maximum');
        const unitIdentity = canonicalHash([item.revision_id, item.unit]);
        if (questionUnits.has(groupId) && questionUnits.get(groupId) !== unitIdentity) {
          throw new Error('all four classes must compare the same frozen scoring unit');
        }
        questionUnits.set(groupId, unitIdentity);
        const classes = byQuestion.get(groupId) ?? new Set<string>();
        if (classes.has(item.answer_class)) throw new Error('duplicate question/class');
        classes.add(item.answer_class);
        byQuestion.set(groupId, classes);
        if (
          item.unit.points === 0 ||
          ((item.answer_class === 'correct' || item.answer_class === 'equivalent') &&
            !samePoints(item.reference_points, item.unit.points)) ||
          (item.answer_class === 'wrong' && item.reference_points !== 0) ||
          (item.answer_class === 'partial' &&
            (item.reference_points <= 0 || item.reference_points >= item.unit.points))
        ) {
          throw new Error(`invalid reference points for ${item.item_id}`);
        }
      }
      if (byQuestion.size < 30 || [...byQuestion.values()].some((classes) => classes.size !== 4)) {
        throw new Error(
          'model_slice_admission_run: at least 30 questions, each with all four classes required',
        );
      }
    }

    if (data.comparison_role === 'reference' && !data.dry_run) {
      throw new Error('reference comparisons must be dry runs; reference models never serve');
    }
    if (data.slice.response_class === 'free' && !data.dry_run && !data.reference_run_id) {
      throw new Error('independent reference run identity required before admission');
    }

    // 逐题判分（生产同源端口；每题独立墙钟，细则含一次超时重试窗口）。
    const budget = resolveTaskBudget(data.slice.task_kind as TaskKind);
    const results: ModelSliceAdmissionItemResult[] = [];
    let knownCostMicros = 0;
    for (const item of data.items) {
      if (currentTaskSpendScope()?.remainingUsd() === 0) {
        failures.push('shared task allowance exhausted or unpriced; no further calls permitted');
        break;
      }
      const livePin = currentModelPinForKind(data.slice.task_kind);
      if (
        livePin?.model !== data.slice.model ||
        livePin.model_version !== data.slice.model_version
      ) {
        failures.push('task configuration changed during comparison; stop before next call');
        break;
      }
      if (knownCostMicros + data.per_item_max_cost_usd_micros > data.total_max_cost_usd_micros) {
        failures.push('total cost cap reached before next call');
        break;
      }
      const port = createAdmissionRunExecutor(
        db,
        data.slice.task_kind,
        Date.now() + admissionCallWindowMs(data.slice.task_kind, budget.timeout),
        data.per_item_max_cost_usd_micros,
      );
      if (port === undefined) {
        throw new Error(
          `model_slice_admission_run: task kind '${data.slice.task_kind}' has no admission-run executor lane`,
        );
      }
      const request: ModelExecutorRequest = {
        submission_id: `holdout_${data.run_id}_${item.item_id}`,
        evaluation_group_id: `holdout_${data.run_id}`,
        revision_id: item.revision_id,
        attempt: 1,
        scoring_unit_id: item.unit.scoring_unit_id,
        executor: {
          kind: 'model_executor',
          task_kind: data.slice.task_kind,
          // 候选切片身份：端口只对 null 切片 fail-closed；准入与否由登记处裁决。
          admitted_slice_id: sliceId,
          max_cost_usd_micros: data.per_item_max_cost_usd_micros,
        },
        unit: item.unit,
        question_parts: item.question_parts,
        response_slots: item.response_slots,
        slot_responses: item.slot_responses,
        group_evidence: item.group_evidence,
        materials: item.materials,
        spent_cost_usd_micros: knownCostMicros,
      };
      const outcome = await port(request);
      const actualRuns =
        outcome.run_refs.length === 0
          ? []
          : await db
              .select({
                id: ai_task_runs.id,
                provider: ai_task_runs.provider,
                model: ai_task_runs.model,
                status: ai_task_runs.status,
                cost_basis: ai_task_runs.cost_basis,
                cost_usd: ai_task_runs.cost_usd,
                input_hash: ai_task_runs.input_hash,
                result_digest: ai_task_runs.result_digest,
                error_message: ai_task_runs.error_message,
              })
              .from(ai_task_runs)
              .where(inArray(ai_task_runs.id, outcome.run_refs));
      if (
        actualRuns.length !== outcome.run_refs.length ||
        actualRuns.some(
          (run) => run.provider !== expectedRoute.provider || run.model !== expectedRoute.model,
        )
      ) {
        failures.push(`actual route evidence missing or differs for ${item.item_id}`);
      }
      results.push(
        holdoutItemFromOutcome(
          {
            item_id: item.item_id,
            reference_points: item.reference_points,
            unit_points: item.unit.points,
          },
          outcome,
        ),
      );
      const lastResult = results.at(-1);
      // 费用已知 = 每条引用 run 都解析到账且按实际用量结算（reported/estimated）。
      // 空 run_refs 或缺行：执行器回报的数字（含 cap 预留）没有账本佐证，按 unknown。
      const actualCostKnown =
        outcome.run_refs.length > 0 &&
        actualRuns.length === outcome.run_refs.length &&
        actualRuns.every(
          (run) =>
            (run.cost_basis === 'reported' || run.cost_basis === 'estimated') &&
            run.cost_usd !== null &&
            Number.isFinite(run.cost_usd) &&
            run.cost_usd >= 0,
        );
      if (lastResult) {
        lastResult.actual_runs = actualRuns;
        // run_refs 末位是定夺 attempt；同题重投共享同一 task input，input digest 恒定。
        const decidingRun =
          outcome.run_refs.length > 0
            ? actualRuns.find((run) => run.id === outcome.run_refs.at(-1))
            : undefined;
        lastResult.input_digest = decidingRun?.input_hash ?? null;
        // outcome 即定夺输出（分数/matched/pending 细节 + run_refs）；逐条封存其
        // canonical digest，与 invoker 写 result_digest 同一哈希约定。
        lastResult.output_digest = sha256Canonical(outcome);
        // 计入 pending 上限的资格：定夺 attempt 真实完成（success）且费用有账。
        // 超时/取消/provider 失败落 failure 或无 run_refs，一律不算完成。
        if (lastResult.status === 'pending') {
          lastResult.model_call_completed = decidingRun?.status === 'success' && actualCostKnown;
        }
        // An executor's fallback cap reserves spend; only settled attempt prices measure it.
        if (outcome.run_refs.length > 0) {
          if (actualCostKnown && actualRuns.length === outcome.run_refs.length) {
            lastResult.cost_usd_micros = Math.ceil(
              actualRuns.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0) * 1_000_000,
            );
          } else delete lastResult.cost_usd_micros;
        }
      }
      knownCostMicros = holdoutRunTally(results).known_cost_usd_micros;
      if (lastResult?.cost_usd_micros === undefined || !actualCostKnown) {
        failures.push('unknown cost; no further paid calls permitted');
      }
      if (failures.length > 0) break;
    }

    const tally = holdoutRunTally(results);
    const severeErrors = tally.severe_errors;
    const agreementRatio = tally.agreement_ratio;
    const unknownCostItems = tally.unknown_cost_items;
    const classResults = answerClasses.map((answerClass) => {
      const members = data.items.filter((item) => item.answer_class === answerClass);
      const errors = members
        .filter((item) => {
          const result = results.find((result) => result.item_id === item.item_id);
          // Pending has no correctness verdict; completeness is checked separately.
          if (result?.status !== 'scored' || result.awarded_points === null) return false;
          if (answerClass === 'partial') return !result.agreed;
          if (answerClass === 'wrong') {
            return (
              result?.status === 'scored' &&
              result.awarded_points !== null &&
              samePoints(result.awarded_points, item.unit.points ?? Number.NaN)
            );
          }
          return !result.agreed;
        })
        .map((item) => item.item_id);
      const unresolved = members
        .filter((item) => {
          const result = results.find((result) => result.item_id === item.item_id);
          return result?.status !== 'scored' || result.awarded_points === null;
        })
        .map((item) => item.item_id);
      return { answer_class: answerClass, items: members.length, errors, unresolved };
    });
    if (data.slice.response_class === 'free') {
      // 未决分两类：模型调用真实完成且费用已结算的显式 pending 按
      // FREE_HOLDOUT_MAX_PENDING_PER_120 比例上限拦；其余未决（超时/取消/
      // provider 失败/无账可对的 pending、未尝试、缺项、scored 无分）一律拦。
      const pendingItemIds = new Set(
        results
          .filter((result) => result.status === 'pending' && result.model_call_completed === true)
          .map((result) => result.item_id),
      );
      const hardUnresolved = classResults
        .flatMap((group) => group.unresolved)
        .filter((itemId) => !pendingItemIds.has(itemId));
      if (hardUnresolved.length > 0) {
        failures.push('unresolved comparison items; no admission evidence');
      }
      const maxPending = Math.floor((data.items.length * FREE_HOLDOUT_MAX_PENDING_PER_120) / 120);
      if (pendingItemIds.size > maxPending) {
        failures.push(
          `pending ${pendingItemIds.size}/${data.items.length} exceeds ${maxPending} (${FREE_HOLDOUT_MAX_PENDING_PER_120} per 120)`,
        );
      }
      for (const group of classResults) {
        if (group.answer_class === 'partial') continue;
        const allowed = group.answer_class === 'wrong' ? 1 : 2;
        if (group.errors.length * 30 > allowed * group.items) {
          failures.push(
            `${group.answer_class}: ${group.errors.length}/${group.items} exceeds ${allowed}/30`,
          );
        }
      }
    } else {
      if (severeErrors > MODEL_SLICE_ADMISSION_THRESHOLDS.max_severe_errors) {
        failures.push(
          `severe_errors ${severeErrors} > ${MODEL_SLICE_ADMISSION_THRESHOLDS.max_severe_errors}`,
        );
      }
      if (agreementRatio < MODEL_SLICE_ADMISSION_THRESHOLDS.min_agreement_ratio) {
        failures.push(
          `agreement_ratio ${agreementRatio.toFixed(4)} < ${MODEL_SLICE_ADMISSION_THRESHOLDS.min_agreement_ratio}`,
        );
      }
    }
    const passed = failures.length === 0;

    // 5) 证据落账（幂等锚 run_id；内部台账，opt out 记忆摄取）。证据总是写 ——
    //    失败的 run 也是准入判断的证据；dry run 的证据同样保留，但绝不推进准入了。
    const now = new Date();
    await writeEvent(db, {
      id: evidenceEventId,
      actor_kind: 'system',
      actor_ref: 'practice:model_slice_admission_run',
      action: 'experimental:model_slice_admission_run',
      subject_kind: 'model_admission_slice',
      subject_id: sliceId,
      outcome: passed ? 'passed' : 'failed',
      payload: {
        version: 2,
        request_digest: canonicalHash(data),
        evidence_kind: 'reference_model_comparison',
        comparison_role: data.comparison_role,
        reference_run_id: data.reference_run_id ?? null,
        calibration: 'uncalibrated',
        class_results: classResults,
        subject_coverage: [...subjects].map(([group_id, coverage]) => ({ group_id, ...coverage })),
        run_id: data.run_id,
        slice: data.slice,
        holdout_digest: data.holdout_digest,
        thresholds:
          data.slice.response_class === 'free'
            ? {
                min_questions: 30,
                wrong_full_per_30: 1,
                correct_nonfull_per_30: 2,
                equivalent_nonfull_per_30: 2,
                partial_bar: null,
                max_pending_per_120: FREE_HOLDOUT_MAX_PENDING_PER_120,
              }
            : MODEL_SLICE_ADMISSION_THRESHOLDS,
        dry_run: data.dry_run,
        items: results,
        agreement_ratio: agreementRatio,
        severe_errors: severeErrors,
        known_cost_usd_micros: knownCostMicros,
        unknown_cost_items: unknownCostItems,
        failures,
      },
      created_at: now,
      ingest_at: now,
    });

    // Replay completes admission after the separately scheduled reference without repaying candidates.
    const storedAfterWrite = await readAdmissionEvidence(db, evidenceEventId);
    if (storedAfterWrite === null) throw new Error('admission evidence write was not readable');
    return finishFromStoredEvidence(
      db,
      storedAfterWrite,
      registrationInput,
      sliceId,
      evidenceEventId,
      data.run_id,
    );
  });
  if ('outcome' in reservedWork) {
    return {
      outcome: 'lock_busy',
      run_id: data.run_id,
      slice_id: sliceId,
      passed: false,
      dry_run: data.dry_run,
      admitted: false,
      failures: ['lock_busy'],
    };
  }
  return reservedWork;
}

export function buildModelSliceAdmissionRunHandler(db: Db) {
  return async (jobs: Job<unknown>[]) => {
    const results: ModelSliceAdmissionRunResult[] = [];
    for (const job of jobs) {
      // lock_busy 是完成态。抛出会让 llm 队列（retryLimit 2）把这次记成 failed 并重试。
      results.push(await runModelSliceAdmission(db, job.data));
    }
    return results;
  };
}
