// YUK-1496 C2 — model_slice_admission_run：模型判分切片的留出题准入 run
// （统一设计 §4 准入门第 4 步；ADR-0073 D2「每科 ≥30 道留出题的模型级准入，
// 与单题标定互不替代」；stage1 G3「准入后登记可查的已准入判分切片」）。
//
// 输入是一套【冻结】留出题：每科 ≥30 道未调参题，带独立参考分。job 用生产
// 同源的执行端口（createAdmissionRunExecutor —— 与正式判分同一装配边界，见
// evaluate-submission.ts）逐题判分，把逐题 agreement / severe error 写成一条
// 事件证据（experimental:model_slice_admission_run，幂等锚 run_id），只有
// 阈值全过且非 dry_run 才登记切片。dry run 绝不准入；没有任何自动准入路径。
//
// 付费说明：本 job 调真实模型，由 lead 在周预算内运行；本 PR 不运行它。
//
// severe error 定义（D17 零容忍方向翻转）：判出分 > unit 满分；参考 0 分而判
// 出 > 0（假得分）；参考满分而判出 0（假零分）。pending/无法判定 = 不一致
// （拉低 agreement），不算 severe —— 诚实 pending 不是判错。

import { inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { type TaskKind, resolveTaskBudget } from '@/capabilities/task-registry';
import { canonicalHash } from '@/core/migration/canonical';
import {
  GroupEvidence,
  type ModelExecutorRequest,
  QuestionPart,
  ResponseSlot,
  ScoringUnit,
  SharedMaterial,
  SlotResponse,
  modelResponseClassForUnit,
} from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { question, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { batchResolveEffectiveDomains } from '@/kernel/read-models/knowledge-tree';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  assertModelAdmissionSliceRegistrable,
  createAdmissionRunExecutor,
  currentModelPins,
  modelSliceIdFor,
  registerModelAdmissionSlice,
} from '../server/judge/evaluate-submission';

/**
 * 准入阈值（config value）。min_items 来自统一设计 §4「每科至少 30 留出题」；
 * max_severe_errors=0 来自 D17 zero severe errors；min_agreement_ratio 是初始
 * 政策值（设计未定数），随第一刀真实留出题实测修订。
 */
export const MODEL_SLICE_ADMISSION_THRESHOLDS = {
  min_items: 30,
  min_agreement_ratio: 0.9,
  max_severe_errors: 0,
} as const;

/** 同一数值口径：卷面十进制分值的二进制表示误差不当差异（与发布校验同律）。 */
function samePoints(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
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
  })
  .strict();

const ModelSliceAdmissionRunData = z
  .object({
    /** 调用方钉的幂等身份（事件 id 锚；重投不重写证据、不重复准入）。 */
    run_id: z.string().min(1),
    slice: z
      .object({
        subject: z.string().min(1),
        response_class: z.enum(['blank', 'free']),
        task_kind: z.string().min(1),
        model: z.string().min(1),
        model_version: z.string().min(1),
      })
      .strict(),
    /** 冻结证明：必须等于 `sha256:${canonicalHash(items)}`，不符即拒跑。 */
    holdout_digest: z.string().min(1),
    items: z.array(HoldoutItem).min(1),
    per_item_max_cost_usd_micros: z.number().int().min(1),
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

export async function runModelSliceAdmission(
  db: Db,
  rawData: unknown,
): Promise<ModelSliceAdmissionRunSummary> {
  const data = ModelSliceAdmissionRunData.parse(rawData);
  const failures: string[] = [];

  // 1) 冻结证明：留出题集 digest 不符 = 集合被改动过，拒跑。
  const actualDigest = `sha256:${canonicalHash(data.items)}`;
  if (actualDigest !== data.holdout_digest) {
    throw new Error(
      `model_slice_admission_run: holdout set is not frozen — digest ${actualDigest} != declared ${data.holdout_digest}`,
    );
  }

  // 2) 切片与当前模型 pin 必须一致：不给「准入一个现在不会执行的模型」留门
  //    （registerModelAdmissionSlice 写前再校验一次，双保险）。
  const pin = currentModelPins().get(data.slice.task_kind);
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
  const sliceId = modelSliceIdFor(data.slice);
  // 证据事件 id 只由 run_id 决定 —— 付费循环前就能算出，供登记预检使用。
  const evidenceEventId = `evt_model_slice_admission_${data.run_id}`;
  const registrationInput = {
    ...data.slice,
    holdout_evidence_ref: evidenceEventId,
    admitted_by: data.admitted_by,
  };

  // 2b) 切片登记预检（付费前置栅栏）：登记处会拒绝的状态（已退役 / 同
  //     slice_id 不同证据或 actor）在这里当场失败 —— 绝不让 ~30 次付费调用
  //     跑完后才在登记处抛错、被队列重跑整段付费循环。幂等可登记的既有行
  //     静默通过（登记处返回既有行，不重复写）。dry run 同样预检：退役切片
  //     的证据不可能再用于登记，付费跑它纯属浪费。
  await assertModelAdmissionSliceRegistrable(db, registrationInput);

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

  // 3b) 学科一致性（付费前置栅栏）：留出题必须真属于切片声明的学科。学科沿
  //     BR-4 canonical bridge 解析 —— revision → 根题 → knowledge_ids[0] →
  //     effective domain → subject profile id；根题缺失、无知识标注或域不可
  //     解析都当场失败，绝不在付费之后才发现留出题集不属于本切片学科。
  const revisionRows = await db
    .select({
      revision_id: question_revision.revision_id,
      group_id: question_revision.group_id,
    })
    .from(question_revision)
    .where(
      inArray(
        question_revision.revision_id,
        data.items.map((item) => item.revision_id),
      ),
    );
  const groupIdByRevision = new Map(revisionRows.map((row) => [row.revision_id, row.group_id]));
  const rootRows = await db
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(inArray(question.id, [...new Set(groupIdByRevision.values())]));
  const firstKnowledgeIdByGroup = new Map(
    rootRows.map((row) => [row.id, row.knowledge_ids[0] ?? null]),
  );
  const domainsByKnowledgeId = await batchResolveEffectiveDomains(
    db,
    [...new Set(firstKnowledgeIdByGroup.values())].filter((id): id is string => id !== null),
  );
  for (const item of data.items) {
    const groupId = groupIdByRevision.get(item.revision_id);
    if (groupId === undefined) {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' revision '${item.revision_id}' does not exist`,
      );
    }
    const firstKnowledgeId = firstKnowledgeIdByGroup.get(groupId) ?? null;
    if (firstKnowledgeId === null) {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' root question '${groupId}' has no knowledge labeling — a holdout item's subject cannot be resolved`,
      );
    }
    const domain = domainsByKnowledgeId.get(firstKnowledgeId) ?? null;
    if (domain === null) {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' knowledge '${firstKnowledgeId}' has no resolvable effective domain`,
      );
    }
    const subject = resolveSubjectProfile(domain).id;
    if (subject !== data.slice.subject) {
      throw new Error(
        `model_slice_admission_run: item '${item.item_id}' resolves to subject '${subject}', not '${data.slice.subject}' — the holdout set does not belong to the slice's subject`,
      );
    }
  }

  // 4) 逐题判分（生产同源端口；每题独立墙钟）。
  const budget = resolveTaskBudget(data.slice.task_kind as TaskKind);
  const results: ModelSliceAdmissionItemResult[] = [];
  let knownCostMicros = 0;
  let unknownCostItems = 0;
  for (const item of data.items) {
    const port = createAdmissionRunExecutor(
      db,
      data.slice.task_kind,
      Date.now() + budget.timeout,
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
    if (outcome.cost_usd_micros !== undefined) knownCostMicros += outcome.cost_usd_micros;
    else unknownCostItems += 1;
    if (outcome.kind !== 'scored') {
      results.push({
        item_id: item.item_id,
        status: 'pending',
        awarded_points: null,
        reference_points: item.reference_points,
        agreed: false,
        severe_error: false,
        pending_reason: outcome.pending.reason,
        run_refs: outcome.run_refs,
        ...(outcome.cost_usd_micros !== undefined
          ? { cost_usd_micros: outcome.cost_usd_micros }
          : {}),
      });
      continue;
    }
    const awarded = outcome.points_awarded;
    const unitMax = item.unit.points;
    const agreed = awarded !== null && samePoints(awarded, item.reference_points);
    const severe =
      awarded !== null &&
      unitMax !== null &&
      (awarded > unitMax ||
        (item.reference_points === 0 && awarded > 0) ||
        (samePoints(item.reference_points, unitMax) && awarded === 0));
    results.push({
      item_id: item.item_id,
      status: 'scored',
      awarded_points: awarded,
      reference_points: item.reference_points,
      agreed,
      severe_error: severe,
      run_refs: outcome.run_refs,
      ...(outcome.cost_usd_micros !== undefined
        ? { cost_usd_micros: outcome.cost_usd_micros }
        : {}),
    });
  }

  const agreed = results.filter((result) => result.agreed).length;
  const severeErrors = results.filter((result) => result.severe_error).length;
  const agreementRatio = results.length === 0 ? 0 : agreed / results.length;
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
      version: 1,
      run_id: data.run_id,
      slice: data.slice,
      holdout_digest: data.holdout_digest,
      thresholds: MODEL_SLICE_ADMISSION_THRESHOLDS,
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

  // 6) 阈值全过且非 dry run 才登记；dry run 永不准入。证据已落账后，登记
  //    失败是终局的未准入结果（failures 带原因、admitted=false），绝不向队列
  //    重抛 —— 重抛会让 pg-boss 重跑整段已付费的判分循环。
  let admitted = false;
  if (passed && !data.dry_run) {
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
    run_id: data.run_id,
    slice_id: sliceId,
    passed,
    dry_run: data.dry_run,
    admitted,
    evidence_event_id: evidenceEventId,
    items: results.length,
    agreed,
    agreement_ratio: agreementRatio,
    severe_errors: severeErrors,
    known_cost_usd_micros: knownCostMicros,
    unknown_cost_items: unknownCostItems,
    failures,
  };
}

export function buildModelSliceAdmissionRunHandler(db: Db) {
  return async (jobs: Job<unknown>[]) => {
    for (const job of jobs) {
      await runModelSliceAdmission(db, job.data);
    }
  };
}
