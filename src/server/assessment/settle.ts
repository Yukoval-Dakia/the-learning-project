// ====================================================================
// YUK-1053 — 学习结算集成：bounded evidence adapter + 同事务结算编排
// ====================================================================
//
// 本模块是 YUK-1045 `activateEvaluation` 注入端口 `LearningSettlementPort` 的
// 真实实现（grounding §8/§11，D13–D16）。它在 activation 事务内：
//
//   - 读冻结契约（revision.structure/response_spec/scoring_basis/execution_plan）
//     与组 KC 作用域（question.knowledge_ids，组根 + 物理 part 行）；
//   - 经纯决策层（`@/core/schema/assessment/settlement`）把 evaluation verdict
//     折成 per-KC 局部证据（success 1 / failure 0 / abstain —— 每 KC ≤1 obs；
//     ambiguous/partial 未局部化 ⇒ abstain；blank_marked_zero 不产生掌握证据）；
//   - bounded evidence adapter：仅在「全部非 abstain KC 共享同一位」时做恰好
//     一次共享 θ̂ update（one-bit conjunctive updater 表达不了 mixed 位，也不
//     能按 KC 重复调用 ⇒ 混合即 abstain；无 fractional θ / 无新 IRT）；
//   - D14 三等级评级（correct→good / partial→hard / incorrect→again；
//     unsupported ⇒ 不调度），SCOPE_V1 = 组内全部非合成 KC 的 knowledge 卡
//     （无 KC ⇒ 组根 question 卡），scope 版本随证据封存；
//   - D15：provenance.source ∈ {manual, self_report} ⇒ 只写 FSRS（用户评级），
//     θ̂ / calibration 不动（无 self-report θ̂）；
//   - D16：provenance.assisted ⇒ 分数保留但 θ̂ / hard-mastery / calibration
//     全排除（explicit manual FSRS 仍允许 —— 评级来源本身是用户）；
//   - FSRS upsert / θ̂ update / family calibration / snapshot brackets 全部在
//     activation 同一事务；advisory lock 纪律不变（G 已由 activateEvaluation
//     持有；per-KC `fsrs:knowledge:<id>` 与 `mastery:ability_global:<domain>`
//     锁由 updateThetaForAttempt 自取，本层先取 FSRS 主体锁）；
//
// 时点纪律（§11「服务端稳定学习顺序，分离 original occurrence/submitted/
// evaluation 时间」）：学习态一律按 `occurrence_at = submission.submitted_at`
// 写（θ̂ last_outcome_at / FSRS now / 标签 θ-before 全部同源）；evaluated_at
// 与 activated_at 独立记录。regrade 不算额外练习。
//
// 有序 replay（§11「更晚到的早期证据走有序 replay，不在完成时追加，也不假
// 装 evidence-only applied」；§12「重算 state、作废 pending/stale 派生结论」）：
//
//   - 本结算的生效范围（occurrence ≥ 本次 occurrence 的 live applied 结算 ×
//     写入主体交集）经【确定性 fixpoint】闭包成 revert 集 R；
//   - R 内成员按最新→最旧 revert（checkpoint bracket 的 A-class 段恢复 +
//     difficulty_calibration_label 按 attempt_event_id 摘除）；任一成员携带
//     不可回退的 family running-mean 折进 ⇒ replay_required（fail-closed，
//     家族残差无法事后相减 —— 不做假 revert）；
//   - 非结算 writer 的更晚痕迹（fsrs.last_review_event_id 不是 live 结算事件、
//     mastery.last_outcome_at 落不到 R 任一成员的 occurrence）⇒ replay_required；
//   - 本结算先按原始 occurrence 落位，R 成员随后按原 occurrence 顺序重放
//     （reapply 读取其 replay_inputs —— 结算事件封存的原判输入，绝不重判）；
//   - regrade（同 group 替换生效判词）：被替换结算先在 revert 集内（user
//     rating 守卫除外，见下），新 verdict 随后落位 —— revert+apply 在同一
//     snapshot 恢复面上完成，θ̂ evidence_count 不凭空 +1 ⇒ 不算额外练习；
//   - replay 任何一步失败 ⇒ 整个 apply savepoint 回滚（含已做 revert），写
//     disposition=replay_required 的结算事件并返回 failed_pending —— receipt
//     不被吞，学习态保持激活前一致性（绝不半 replay）；
//
//   - D4 对偶：用户评级 provenance 独立 —— 被替换结算的评级若来自
//     manual/self_report，其 FSRS 段【绝不】被 judge 纠正在本层静默覆盖
//     （skip FSRS revert + skip 本次 FSRS apply；θ̂ 段照常独立更正 ——
//     「有效判分证据独立地可以更新 θ̂」）。
//
// 消费契约（YUK-1054 依赖）：每个 settlement 事件封存 original（被替换的）
// 与 effective（本次）双方 —— `supersedes_evaluation_id`/`supersedes_
// settlement_event_id`/`replay_of`/`reverted_settlement_event_ids` 全部显式；
// replay_required 事件是有序 replay 的显式 worklist 条目（disposition 字段），
// 下游消费者据此区分「已结算事实」与「待 replay 义务」。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  SYNTHETIC_SUBJECT_ROOT_RE,
  writeAttemptSnapshotBrackets,
} from '@/capabilities/practice/public';
import { scheduleReview } from '@/core/fsrs';
import type {
  ExecutionPlanT,
  KcObservation,
  QuestionGroupStructureT,
  ResponseSpecT,
  ScoringBasisT,
} from '@/core/schema/assessment';
import {
  EvaluationProvenance,
  SETTLEMENT_SCOPE_VERSION,
  deriveCoarseVerdict,
  localizeKcObservations,
  ratingForVerdict,
  resolveThetaDecision,
} from '@/core/schema/assessment';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { Tx } from '@/db/client';
import {
  difficulty_calibration_label,
  event,
  mastery_state,
  material_fsrs_state,
  question,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import {
  type FamilyFoldRecord,
  recordFamilyObservationForAttempt,
  unfoldFamilyCalibration,
} from '@/server/mastery/personalized-difficulty';
import {
  type AbilityGlobalByKnowledgeId,
  getMasteryState,
  resolveAbilityGlobalByKnowledgeId,
  updateThetaForAttempt,
} from '@/server/mastery/state';
import { orchestrateCascadeRevert } from '@/server/revert/cascade-revert';
import type { ActivationEffect, ActivationSettleInput } from './activate';

export const ASSESSMENT_SETTLEMENT_ACTION = 'experimental:assessment_settlement';
export const ASSESSMENT_SETTLEMENT_VERSION = 1 as const;

// ---------- 形状 ----------

interface QuestionLite {
  id: string;
  knowledge_ids: string[];
  difficulty: number;
  kind: string;
  source: string;
}

interface FsrsSubject {
  kind: 'question' | 'knowledge';
  id: string;
}

interface ThetaApply {
  applied: true;
  outcome: 0 | 1;
  knowledgeIds: string[];
  anchorQuestionId: string;
  anchorDifficulty: number;
  anchorKind: string;
  anchorSource: string;
  familyPrimaryKnowledgeId: string | null;
  abilityGlobalByKnowledgeId: AbilityGlobalByKnowledgeId;
}

interface SettlementPlan {
  kind: 'plan';
  groupId: string;
  submissionId: string;
  evaluationId: string;
  attempt: number;
  /** 学习事实时点（§11 occurrence）：submission.submitted_at（ISO）。 */
  occurrenceAt: string;
  /** 评估完成时点（evaluation.created_at，ISO）。 */
  evaluatedAt: string;
  provenance: { source: 'automatic' | 'manual' | 'self_report'; assisted: boolean };
  verdict: { verdict: string; reason: string; points: number | null; normalized: number | null };
  /** D14 评级；null = 不调度（unsupported/无 ratable verdict）。 */
  rating: 'again' | 'hard' | 'good' | null;
  /** 评级来源：'user' = manual/self_report provenance（用户已确认评级）。 */
  ratingSource: 'verdict' | 'user' | 'none';
  scopeVersion: number;
  scopeKcIds: string[];
  fsrsSubjects: FsrsSubject[];
  kcObservations: KcObservation[];
  theta: ThetaApply | { applied: false; abstainReason: string };
  /** family/difficulty calibration 的判分路由面（全 deterministic 才 'exact'）。 */
  judgeRoute: string;
  /** practice_stream_item.id —— 契约层当前无流 slot 归属，恒 null（如实记）。 */
  difficultyLabelStreamItemId: string | null;
}

interface AppliedSettlementEvent {
  id: string;
  groupId: string;
  evaluationId: string;
  occurrenceMs: number;
  createdMs: number;
  /** 该结算实际触碰的主体（'kind:id'）—— replay 冲突域。 */
  subjects: Set<string>;
  /** 该结算实际写下的 FSRS 主体（'kind:id'）—— re-apply 保真（原事件跳过 FSRS ⇒ 重放也跳过）。 */
  fsrsApplied: string[];
  familyObservationRecorded: boolean;
  /** 该结算留下的 family fold（null = 未触）—— revert 的逆输入。 */
  familyFold: FamilyFoldRecord | null;
  inputs: SettlementPlan;
}

type ReplayRequired =
  | { kind: 'family_fold_missing'; settlementEventId: string }
  | { kind: 'family_fold_drift'; settlementEventId: string }
  | { kind: 'unreplayable_member'; settlementEventId: string; reason: string }
  | { kind: 'unattributed_newer_write'; subject: string; detail: string }
  | { kind: 'revert_failed'; settlementEventId: string; refusal: string }
  | { kind: 'reapply_failed'; settlementEventId: string; reason: string };

// ---------- 纯函数 ----------

function coerceMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function normalizeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
}

function contentKcs(ids: readonly string[]): string[] {
  return normalizeIds(ids).filter((id) => !SYNTHETIC_SUBJECT_ROOT_RE.test(id));
}

function subjectKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** unit → 其作答面 part 集：槽位引用的 part 并集；无槽引用 ⇒ 组级（空集标记）。 */
function unitPartIdsOf(basis: ScoringBasisT, spec: ResponseSpecT): Map<string, Set<string>> {
  const partBySlot = new Map(spec.slots.map((s) => [s.slot_id, s.part_id] as const));
  const map = new Map<string, Set<string>>();
  for (const unit of basis.units) {
    const parts = new Set<string>();
    for (const slotId of [...unit.slot_refs, ...unit.evidence_slot_refs]) {
      const partId = partBySlot.get(slotId);
      if (partId !== undefined) parts.add(partId);
    }
    map.set(unit.scoring_unit_id, parts);
  }
  return map;
}

/** unit → 判它的执行器 kind（execution_plan assignment 覆盖唯一，1046 已校验）。 */
function unitExecutorKinds(plan: ExecutionPlanT): Map<string, string> {
  const map = new Map<string, string>();
  for (const assignment of plan.assignments) {
    for (const unitId of assignment.scoring_unit_ids) {
      map.set(unitId, assignment.executor.kind);
    }
  }
  return map;
}

function planFromPayload(raw: unknown): SettlementPlan | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.kind !== 'plan') return null;
  if (typeof p.groupId !== 'string' || typeof p.evaluationId !== 'string') return null;
  if (typeof p.occurrenceAt !== 'string' || coerceMs(p.occurrenceAt) === null) return null;
  if (typeof p.fsrsSubjects === 'undefined' || !Array.isArray(p.fsrsSubjects)) return null;
  if (!Array.isArray(p.kcObservations) || typeof p.theta !== 'object' || p.theta === null) {
    return null;
  }
  return p as unknown as SettlementPlan;
}

// ---------- 范围装载 ----------

/** 事件 effects.family_fold 的解析（乱掉/缺省一律 null = 无 fold 可逆）。 */
function parseFamilyFold(raw: unknown): FamilyFoldRecord | null {
  if (raw === null || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.familyKey !== 'string' || typeof f.residual !== 'number') return null;
  if (typeof f.folded !== 'boolean') return null;
  return { familyKey: f.familyKey, folded: f.folded, residual: f.residual };
}

interface SettlementScope {
  groupRow: QuestionLite | null;
  partRows: Map<string, QuestionLite>;
  spec: ResponseSpecT;
  basis: ScoringBasisT;
  plan: ExecutionPlanT;
}

async function loadScope(tx: Tx, input: ActivationSettleInput): Promise<SettlementScope> {
  const [revision] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, input.submission.revision_id))
    .limit(1);
  if (!revision) {
    throw new Error(
      `assessment settlement: revision '${input.submission.revision_id}' missing — submission coordinate corrupt (fail-closed)`,
    );
  }
  const spec = revision.response_spec as ResponseSpecT;
  const basis = revision.scoring_basis as ScoringBasisT;
  const plan = revision.execution_plan as ExecutionPlanT;
  const structure = revision.structure as QuestionGroupStructureT;

  const partIds = structure.parts.map((part) => part.part_id);
  const wanted = new Set<string>([input.questionGroupId, ...partIds]);
  const rows = await tx
    .select({
      id: question.id,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
      kind: question.kind,
      source: question.source,
    })
    .from(question)
    .where(inArray(question.id, [...wanted]));
  const byId = new Map<string, QuestionLite>(rows.map((r) => [r.id, r as QuestionLite]));
  const partRows = new Map<string, QuestionLite>();
  for (const partId of partIds) {
    const row = byId.get(partId);
    if (row) partRows.set(partId, row);
  }
  return { groupRow: byId.get(input.questionGroupId) ?? null, partRows, spec, basis, plan };
}

// ---------- 计划推导 ----------

function derivePlan(input: ActivationSettleInput, scope: SettlementScope): SettlementPlan {
  const groupKcs = contentKcs(scope.groupRow?.knowledge_ids ?? []);
  const partKcIds = new Map<string, string[]>();
  const scopeSet = new Set<string>(groupKcs);
  // part → KC：物理 part 行用自身 knowledge_ids；虚拟 part（structured 叶，
  // 无行）回落组级。空数组回落组级（该 part 无独立标签语义）。
  for (const [partId, row] of scope.partRows) {
    const kcs = contentKcs(row.knowledge_ids);
    partKcIds.set(partId, kcs.length > 0 ? kcs : groupKcs);
    for (const kc of kcs) scopeSet.add(kc);
  }
  const scopeKcIds = [...scopeSet].sort();

  const verdict = deriveCoarseVerdict(
    { status: input.evaluation.status, aggregate: input.evaluation.aggregate ?? null },
    scope.basis,
  );
  const provenance = EvaluationProvenance.catch({ source: 'automatic', assisted: false }).parse(
    input.evaluation.provenance ?? {},
  );
  const unitPartIds = unitPartIdsOf(scope.basis, scope.spec);
  const observations = localizeKcObservations(scope.basis, input.evaluation.unit_results, {
    unitPartIds,
    partKcIds,
    groupKcIds: scopeKcIds,
  });
  const thetaDecision = resolveThetaDecision(observations, provenance);

  const rating = ratingForVerdict(verdict.verdict);
  const ratingSource: SettlementPlan['ratingSource'] =
    rating === null ? 'none' : provenance.source === 'automatic' ? 'verdict' : 'user';
  const fsrsSubjects: FsrsSubject[] =
    scopeKcIds.length > 0
      ? scopeKcIds.map((id) => ({ kind: 'knowledge' as const, id }))
      : [{ kind: 'question' as const, id: input.questionGroupId }];

  const executorKinds = unitExecutorKinds(scope.plan);
  const scoredUnitIds = new Set(
    input.evaluation.unit_results
      .filter((r) => r.status === 'scored')
      .map((r) => r.scoring_unit_id),
  );
  const judgeRoute =
    scoredUnitIds.size > 0 &&
    [...scoredUnitIds].every((id) => executorKinds.get(id) === 'deterministic')
      ? 'exact'
      : 'contract_evaluation';

  let theta: SettlementPlan['theta'];
  if (thetaDecision.kind === 'abstain') {
    theta = { applied: false, abstainReason: thetaDecision.reason };
  } else {
    // 锚：update KC 全部归属于同一 part ⇒ 该 part 行（part = 物理 question 行，
    // item_calibration 按行成键）；跨 part ⇒ 组根行（难度/族键的组级代表）。
    const partsCovering = new Set<string>();
    const updateSet = new Set(thetaDecision.knowledgeIds);
    for (const [partId, kcs] of partKcIds) {
      if (kcs.some((kc) => updateSet.has(kc))) partsCovering.add(partId);
    }
    const anchor =
      partsCovering.size === 1
        ? (scope.partRows.get([...partsCovering][0]) ?? scope.groupRow)
        : scope.groupRow;
    if (!anchor) {
      theta = { applied: false, abstainReason: 'anchor_unavailable' };
    } else {
      theta = {
        applied: true,
        outcome: thetaDecision.outcome,
        knowledgeIds: thetaDecision.knowledgeIds,
        anchorQuestionId: anchor.id,
        anchorDifficulty: anchor.difficulty,
        anchorKind: anchor.kind,
        anchorSource: anchor.source,
        familyPrimaryKnowledgeId: anchor.knowledge_ids[0] ?? null,
        abilityGlobalByKnowledgeId: {}, // derivePlanAsync 填充
      };
    }
  }

  return {
    kind: 'plan',
    groupId: input.evaluation.evaluation_group_id,
    submissionId: input.submission.submission_id,
    evaluationId: input.evaluation.evaluation_id,
    attempt: input.evaluation.attempt,
    occurrenceAt: input.submission.submitted_at.toISOString(),
    evaluatedAt: input.evaluation.created_at.toISOString(),
    provenance,
    verdict: {
      verdict: verdict.verdict,
      reason: verdict.reason,
      points: verdict.points,
      normalized: verdict.normalized,
    },
    rating,
    ratingSource,
    scopeVersion: SETTLEMENT_SCOPE_VERSION,
    scopeKcIds,
    fsrsSubjects,
    kcObservations: observations,
    theta,
    judgeRoute,
    difficultyLabelStreamItemId: null,
  };
}

// ---------- 结算事件面 ----------

function planSubjects(plan: SettlementPlan): Set<string> {
  const subjects = new Set<string>();
  if (plan.rating !== null) {
    for (const s of plan.fsrsSubjects) subjects.add(subjectKey(s.kind, s.id));
  }
  if (plan.theta.applied) {
    for (const kc of plan.theta.knowledgeIds) subjects.add(subjectKey('knowledge', kc));
    for (const domain of Object.values(plan.theta.abilityGlobalByKnowledgeId)) {
      subjects.add(subjectKey('ability_global', domain));
    }
  }
  return subjects;
}

interface SettlementEventRow {
  id: string;
  createdMs: number;
  groupId: string | null;
  evaluationId: string | null;
  effect: string | null;
  occurrenceMs: number | null;
  subjects: Set<string>;
  /** 该结算实际写下的 FSRS 主体（'kind:id'）—— user-rating provenance 回溯 + replay 保真。 */
  fsrsApplied: string[];
  familyObservationRecorded: boolean;
  familyFold: FamilyFoldRecord | null;
  inputs: SettlementPlan | null;
  supersedesSettlementEventId: string | null;
  revertedIds: string[];
  replayOf: string | null;
}

async function loadSettlementEvents(tx: Tx): Promise<SettlementEventRow[]> {
  const rows = await tx
    .select({ id: event.id, created_at: event.created_at, payload: event.payload })
    .from(event)
    .where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));
  const out: SettlementEventRow[] = [];
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const effects = (p.effects ?? {}) as Record<string, unknown>;
    const subjects = new Set<string>(
      Array.isArray(effects.subjects)
        ? (effects.subjects as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
    );
    out.push({
      id: row.id,
      createdMs: coerceMs(row.created_at) ?? 0,
      groupId: typeof p.evaluation_group_id === 'string' ? p.evaluation_group_id : null,
      evaluationId: typeof p.evaluation_id === 'string' ? p.evaluation_id : null,
      effect: typeof p.effect === 'string' ? p.effect : null,
      occurrenceMs: coerceMs(p.occurrence_at as string | undefined),
      subjects,
      fsrsApplied: Array.isArray(effects.fsrs_applied)
        ? (effects.fsrs_applied as unknown[]).filter((v): v is string => typeof v === 'string')
        : [],
      familyObservationRecorded: effects.family_observation_recorded === true,
      familyFold: parseFamilyFold(effects.family_fold),
      inputs: planFromPayload(p.replay_inputs),
      supersedesSettlementEventId:
        typeof p.supersedes_settlement_event_id === 'string'
          ? p.supersedes_settlement_event_id
          : null,
      revertedIds: Array.isArray(p.reverted_settlement_event_ids)
        ? (p.reverted_settlement_event_ids as unknown[]).filter(
            (v): v is string => typeof v === 'string',
          )
        : [],
      replayOf: typeof p.replay_of === 'string' ? p.replay_of : null,
    });
  }
  return out;
}

/** live applied 结算（applied 且未被任何后续事件 revert/supersede/replay）。 */
function liveAppliedSettlements(rows: SettlementEventRow[]): AppliedSettlementEvent[] {
  const dead = new Set<string>();
  for (const row of rows) {
    if (row.supersedesSettlementEventId) dead.add(row.supersedesSettlementEventId);
    for (const id of row.revertedIds) dead.add(id);
    if (row.replayOf) dead.add(row.replayOf);
  }
  const live: AppliedSettlementEvent[] = [];
  for (const row of rows) {
    if (row.effect !== 'applied' || dead.has(row.id) || row.occurrenceMs === null) continue;
    if (row.inputs === null) continue; // 无 replay 输入的 applied 行不可参与闭包
    live.push({
      id: row.id,
      groupId: row.groupId ?? '',
      evaluationId: row.evaluationId ?? '',
      occurrenceMs: row.occurrenceMs,
      createdMs: row.createdMs,
      subjects: row.subjects,
      fsrsApplied: row.fsrsApplied,
      familyObservationRecorded: row.familyObservationRecorded,
      familyFold: row.familyFold,
      inputs: row.inputs,
    });
  }
  return live;
}

/** revert/re-apply 顺序：occurrence ASC → created ASC → id ASC（稳定全序）。 */
function byOccurrenceAsc(a: AppliedSettlementEvent, b: AppliedSettlementEvent): number {
  return a.occurrenceMs - b.occurrenceMs || a.createdMs - b.createdMs || a.id.localeCompare(b.id);
}

/**
 * replay 闭包（确定性 fixpoint）：种子 = occurrence ≥ minOccurrenceBound 且主
 * 体与 mySubjects 相交的 live 结算；扩张 = 已入集成员触碰的主体再吸进满足
 * 同一下界的结算（不同 occurrence 段的 revert/re-apply 顺序靠闭包完整覆盖）。
 * 同组成员永远不入闭包 —— 本组被替换结算由 replaced 通道单独处理。
 */
function replayClosure(
  live: AppliedSettlementEvent[],
  input: { minOccurrenceMs: number; excludeGroupId: string; seedSubjects: Set<string> },
): AppliedSettlementEvent[] {
  const members = new Map<string, AppliedSettlementEvent>();
  const covered = new Set<string>(input.seedSubjects);
  const eligible = (m: AppliedSettlementEvent): boolean =>
    m.groupId !== input.excludeGroupId && m.occurrenceMs >= input.minOccurrenceMs;
  const absorb = (m: AppliedSettlementEvent) => {
    if (members.has(m.id)) return;
    members.set(m.id, m);
    for (const s of m.subjects) covered.add(s);
  };
  for (const m of live) {
    if (!eligible(m)) continue;
    for (const s of m.subjects) {
      if (input.seedSubjects.has(s)) {
        absorb(m);
        break;
      }
    }
  }
  // fixpoint：反复把触碰 covered 主体的合格成员吸进来（live 集有限 ⇒ 必终止）。
  for (;;) {
    let grew = false;
    for (const m of live) {
      if (members.has(m.id) || !eligible(m)) continue;
      for (const s of m.subjects) {
        if (covered.has(s)) {
          absorb(m);
          grew = true;
          break;
        }
      }
    }
    if (!grew) return [...members.values()];
  }
}

// ---------- 执行（apply / revert / reapply） ----------

interface ApplyOutcome {
  fsrsApplied: string[];
  thetaApplied: string[];
  /** family 观测是否写入（含未折进 mean 的纯 evidence_count 记录）。 */
  familyObservationRecorded: boolean;
  /** 实际折进记录（null = 未触校准行）—— un-fold 的逆运算输入。 */
  familyFold: FamilyFoldRecord | null;
  subjects: Set<string>;
}

/**
 * 落位单个 plan 的学习效应（不重判：全部输入来自 plan.replay_inputs 等价物）。
 * 先 FSRS（评级），再 θ̂（bounded adapter 单次共享 update），再 brackets，
 * 最后 calibration（family 观测仅在 objective + θ̂ applied 时折进）。
 */
async function executePlan(
  tx: Tx,
  plan: SettlementPlan,
  settlementEventId: string,
  occurrenceAt: Date,
  options: { skipFsrs?: boolean } = {},
): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = {
    fsrsApplied: [],
    thetaApplied: [],
    familyObservationRecorded: false,
    familyFold: null,
    subjects: planSubjects(plan),
  };

  // ---- FSRS（D14 三等级；rating=null ⇒ 不调度）----
  const fsrsSnapshots: Array<{
    subject_kind: 'question' | 'knowledge';
    subject_id: string;
    before: FsrsStateSchemaT | null;
    after: FsrsStateSchemaT;
  }> = [];
  if (plan.rating !== null && !options.skipFsrs) {
    // 主体锁：sorted 序取 `fsrs:<kind>:<id>`（与 updateThetaForAttempt 的
    // `fsrs:knowledge:<id>` 同 namespace；G 已由 activation 持有）。
    const keys = plan.fsrsSubjects.map((s) => subjectKey(s.kind, s.id)).sort();
    for (const key of keys) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${key}`}))`);
    }
    for (const subject of plan.fsrsSubjects) {
      const source = await getFsrsState(tx, subject.kind, subject.id);
      const before = source?.state ?? null;
      const scheduled = source
        ? scheduleReview(
            { ...source.state, last_review: source.state.last_review ?? null },
            plan.rating,
            occurrenceAt,
          )
        : scheduleReview(null, plan.rating, occurrenceAt);
      const after: FsrsStateSchemaT = {
        ...scheduled.nextState,
        last_review: scheduled.nextState.last_review ?? null,
      };
      fsrsSnapshots.push({
        subject_kind: subject.kind,
        subject_id: subject.id,
        before,
        after,
      });
      await upsertFsrsState(tx, {
        subject_kind: subject.kind,
        subject_id: subject.id,
        state: after,
        due_at: scheduled.dueAt,
        last_review_event_id: settlementEventId,
      });
      outcome.fsrsApplied.push(subjectKey(subject.kind, subject.id));
    }
  }

  // ---- θ̂（bounded adapter：恰好一次共享 update）----
  const thetaSnapshots: Awaited<ReturnType<typeof updateThetaForAttempt>>['theta_snapshots'] = [];
  let thetaBefore = 0;
  if (plan.theta.applied) {
    const theta = plan.theta;
    const familyPrimary = theta.familyPrimaryKnowledgeId ?? theta.knowledgeIds[0] ?? null;
    thetaBefore =
      familyPrimary !== null ? ((await getMasteryState(tx, familyPrimary))?.theta_hat ?? 0) : 0;
    const result = await updateThetaForAttempt(tx, {
      knowledgeIds: theta.knowledgeIds,
      questionId: theta.anchorQuestionId,
      outcome: theta.outcome,
      difficulty: theta.anchorDifficulty,
      attemptEventId: settlementEventId,
      now: occurrenceAt,
      kind: theta.anchorKind,
      source: theta.anchorSource,
      familyPrimaryKnowledgeId: familyPrimary,
      ...(Object.keys(theta.abilityGlobalByKnowledgeId).length > 0
        ? { abilityGlobalByKnowledgeId: theta.abilityGlobalByKnowledgeId }
        : {}),
    });
    thetaSnapshots.push(...result.theta_snapshots);
    outcome.thetaApplied = [...theta.knowledgeIds];
  }

  // ---- A-class 恢复 bracket（每个 moved 轴一段；replay/纠错的机械基础）----
  await writeAttemptSnapshotBrackets(tx, {
    attemptEventId: settlementEventId,
    sessionId: null,
    now: occurrenceAt,
    thetaSnapshots,
    fsrsSnapshots,
  });

  // ---- calibration（D16 已在 plan 层排除 assisted/manual；objective 才折）----
  if (plan.theta.applied) {
    const theta = plan.theta;
    try {
      await tx.transaction(async (sp) => {
        outcome.familyFold = await recordFamilyObservationForAttempt(sp, {
          primaryKnowledgeId: theta.familyPrimaryKnowledgeId ?? theta.knowledgeIds[0] ?? null,
          questionId: theta.anchorQuestionId,
          kind: theta.anchorKind,
          source: theta.anchorSource,
          difficulty: theta.anchorDifficulty,
          outcome: theta.outcome,
          attemptOutcome: theta.outcome === 1 ? 'success' : 'failure',
          judgeRoute: plan.judgeRoute,
          thetaBefore,
          now: occurrenceAt,
        });
      });
      // 回执非 null = 行被写（门未过时也可能是「未折进 mean」的纯计数记录——
      // 如实封存，revert 按 record.folded 决定是否逆均值）。
      outcome.familyObservationRecorded = outcome.familyFold !== null;
    } catch (err) {
      console.warn(
        '[assessment-settle] recordFamilyObservationForAttempt failed (non-fatal):',
        err,
      );
    }
  }
  return outcome;
}

/** revert 一个 live 结算成员（A-class 段 + family fold 逆运算 + 标签订除）。失败 ⇒ ReplayRequired。 */
async function revertSettlementMember(
  tx: Tx,
  member: AppliedSettlementEvent,
  options: { skipFsrsSegment?: boolean } = {},
): Promise<ReplayRequired | null> {
  // family fold：封存残差是 self-contained 的逆运算输入（running mean 对次序不敏感）——
  // 精确 un-fold；drift（record 称已折但 calibrated_n=0）⇒ 非结算路径动过 ⇒ fail-closed。
  if (member.familyObservationRecorded) {
    if (member.familyFold === null) {
      return { kind: 'family_fold_missing', settlementEventId: member.id };
    }
    const un = await unfoldFamilyCalibration(tx, { record: member.familyFold, now: new Date() });
    if (un === 'drift') {
      return { kind: 'family_fold_drift', settlementEventId: member.id };
    }
  }
  const segments: Array<'theta' | 'fsrs'> = options.skipFsrsSegment ? ['theta'] : ['theta', 'fsrs'];
  for (const segment of segments) {
    const checkpointId = `${member.id}:checkpoint:${segment}`;
    const result = await orchestrateCascadeRevert(tx, checkpointId, {
      reasonContext: { note: `assessment settlement replay (revert ${member.id})` },
    });
    if (!result.ok) {
      if (result.refusal === 'no_checkpoint') {
        // 段无 bracket = 该成员这段没动过（theta abstain / fsrs unrated）——
        // 不是错误，继续其它段。
        continue;
      }
      return {
        kind: 'revert_failed',
        settlementEventId: member.id,
        refusal: `${result.refusal}: ${result.reason}`,
      };
    }
  }
  // 摘除该成员写入的 difficulty_calibration_label（attempt_event_id 成键）——
  // 防止 re-apply 换新事件 id 后旧标签残留成双。
  await tx
    .delete(difficulty_calibration_label)
    .where(eq(difficulty_calibration_label.attempt_event_id, member.id));
  return null;
}

/** 结算事件落盘（消费契约面：original/effective 双方显式封存）。 */
async function writeSettlementEvent(
  tx: Tx,
  input: {
    id: string;
    plan: SettlementPlan | null;
    effect: 'applied' | 'ineligible' | 'replay_required';
    activatedAt: Date;
    occurrenceAt: Date | null;
    groupId: string;
    submissionId: string;
    evaluationId: string;
    priorEffectiveEvaluationId: string | null;
    supersedesSettlementEventId: string | null;
    replayOf: string | null;
    revertedIds: string[];
    appliedOutcome: ApplyOutcome | null;
    reasonDetail?: Record<string, unknown>;
  },
): Promise<void> {
  const plan = input.plan;
  await writeEvent(tx, {
    id: input.id,
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'assessment_settlement',
    action: ASSESSMENT_SETTLEMENT_ACTION,
    subject_kind: 'evaluation_group',
    subject_id: input.groupId,
    outcome: input.effect === 'applied' ? 'success' : null,
    payload: {
      version: ASSESSMENT_SETTLEMENT_VERSION,
      evaluation_id: input.evaluationId,
      evaluation_group_id: input.groupId,
      submission_id: input.submissionId,
      attempt: plan?.attempt ?? null,
      effect: input.effect,
      occurrence_at: input.occurrenceAt?.toISOString() ?? null,
      evaluated_at: plan?.evaluatedAt ?? null,
      activated_at: input.activatedAt.toISOString(),
      supersedes_evaluation_id: input.priorEffectiveEvaluationId,
      supersedes_settlement_event_id: input.supersedesSettlementEventId,
      replay_of: input.replayOf,
      reverted_settlement_event_ids: input.revertedIds,
      scope_version: plan?.scopeVersion ?? null,
      verdict: plan?.verdict ?? null,
      rating: plan?.rating ?? null,
      rating_source: plan?.ratingSource ?? null,
      provenance: plan?.provenance ?? null,
      kc_observations: plan?.kcObservations ?? [],
      theta_decision: plan?.theta ?? null,
      effects: input.appliedOutcome
        ? {
            subjects: [...input.appliedOutcome.subjects].sort(),
            fsrs_applied: input.appliedOutcome.fsrsApplied,
            theta_applied: input.appliedOutcome.thetaApplied,
            family_observation_recorded: input.appliedOutcome.familyObservationRecorded,
            family_fold: input.appliedOutcome.familyFold,
          }
        : {
            subjects: [],
            fsrs_applied: [],
            theta_applied: [],
            family_observation_recorded: false,
            family_fold: null,
          },
      // replay worklist 面：本结算【将触碰】的主体域（applied 时 = effects.subjects；
      // replay_required 时是 replay 消费者需要的冲突域，不是空集）。
      planned_subjects: plan ? [...planSubjects(plan)].sort() : [],
      replay_inputs: plan ?? null,
      ...(input.reasonDetail ?? {}),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    ingest_at: input.activatedAt,
    created_at: input.activatedAt,
  });
}

// ---------- 主入口（LearningSettlementPort 实现） ----------

/**
 * activation 同事务学习结算。必须由 `activateEvaluation` 在持有全局
 * learning-state 写锁 G 的事务内调用（端口契约）；本函数不另开顶层事务，
 * replay 段用嵌套 savepoint 保护。
 */
export async function learningSettlement(input: ActivationSettleInput): Promise<ActivationEffect> {
  const { tx } = input;
  const activatedAt = input.now;
  const occurrenceAt = input.submission.submitted_at;
  const occurrenceMs = occurrenceAt.getTime();

  // ---- 计划（冻结契约 + 组 KC 作用域；纯判定无写）----
  const scope = await loadScope(tx, input);
  const plan = derivePlan(input, scope);
  // θ̂ 依赖域映射（HIERARCHICAL_ELO_ENABLED 开时为真；冻结进 replay 输入，
  // re-apply 不重解析 —— 与 durable judge 的冻结语义同款）。
  if (plan.theta.applied) {
    plan.theta.abilityGlobalByKnowledgeId = await resolveAbilityGlobalByKnowledgeId(
      tx,
      plan.theta.knowledgeIds,
    );
  }
  const mySubjects = planSubjects(plan);
  const settlementEventId = `stl_${createId()}`;

  // ---- live applied 结算面 + 被替换结算定位 ----
  const rows = await loadSettlementEvents(tx);
  const live = liveAppliedSettlements(rows);
  const priorEffectiveId = input.head.effective_evaluation_id;
  const replaced: AppliedSettlementEvent[] = priorEffectiveId
    ? live.filter((m) => m.groupId === plan.groupId && m.evaluationId === priorEffectiveId)
    : [];
  if (replaced.length > 1) {
    // 同一 effective evaluation 有 >1 live applied 结算 = 数据不一致（CAS 应
    // 已阻止多写）；fail-closed 到 replay_required，不猜谁是权威。
    await writeReplayRequired(tx, {
      eventId: settlementEventId,
      plan,
      activatedAt,
      priorEffectiveEvaluationId: priorEffectiveId,
      detail: {
        kind: 'ambiguous_prior_settlement',
        settlement_event_ids: replaced.map((m) => m.id),
      },
    });
    return 'failed_pending';
  }
  const replacedMember = replaced[0] ?? null;
  // user-rating 守卫（D4 对偶，YUK-1093 P1-2）：被覆写侧的 live FSRS 状态若
  // 最后一次由 user rating（manual/self_report）结算写入 ⇒ 其 FSRS 段不被本
  // 层静默覆盖；本次 FSRS 也不再写（保持用户评级）。θ̂ 段照常 revert/更正
  // （判分证据独立）。
  //
  // 「直接前驱」不足以判明：manual→auto→auto 链上中间那环经守卫只写了 θ̂，
  // 卡面仍是 manual 那环的；只看直接前驱会让第二次纠正静默覆盖用户调度。
  // 检查面 = 我【将写】的 FSRS 主体 ∪ 被替换结算【写过】的 FSRS 主体（事件
  // 已死/非结算写者 ⇒ 不算用户来源，照旧让位 / 由 unattributed 检测接管）。
  const fsrsAtRisk = new Set<string>();
  if (plan.rating !== null) {
    for (const s of plan.fsrsSubjects) fsrsAtRisk.add(subjectKey(s.kind, s.id));
  }
  if (replacedMember !== null) {
    for (const s of replacedMember.fsrsApplied) fsrsAtRisk.add(s);
  }
  const lastWriterIsUser = await preservedUserRatingExists(tx, rows, [...fsrsAtRisk]);
  // 评级 provenance 随链携带「直到显式被另一个用户评级替换」：本次评级同样
  // 来自用户 ⇒ 不保留（新评级正常落位）；verdict 评级 ⇒ 保留用户排程。
  const preserveUserRating = plan.ratingSource !== 'user' && lastWriterIsUser;

  // ---- replay 闭包：occurrence ≥ mine 且与我的写入主体相交的 live 结算 ----
  // YUK-1093 P1-3 — 种子 = 本结算主体 ∪ 被替换结算主体。全量 regrade（如
  // correct→unsupported）下 mySubjects 可为空，但 S_old 的写入仍要 revert：
  // 不播被替换主体，碰到其主体的更晚异组结算就不入闭包 —— revert S_old 撞上
  // 对方的 snapshot 链 ⇒ revert_failed ⇒ failed_pending（§12 许诺的有序
  // replay 变成 false negative）。异组主体的更晚写入天然就在 S_old 的恢复
  // 面上，必须把对方 revert+重放。
  const seedSubjects = new Set<string>(mySubjects);
  if (replacedMember !== null) {
    for (const s of replacedMember.subjects) seedSubjects.add(s);
  }
  const conflictSet = replayClosure(live, {
    minOccurrenceMs: occurrenceMs,
    excludeGroupId: plan.groupId,
    seedSubjects,
  });

  // ---- 无冲突快路径（首次顺序结算；regrade 也走这里做 revert+apply）----
  const revertSet = [...conflictSet];
  if (replacedMember !== null) revertSet.push(replacedMember);
  const reapplySet = conflictSet.slice().sort(byOccurrenceAsc);
  const revertOrder = revertSet.slice().sort(byOccurrenceAsc).reverse();

  // ---- 非结算 writer 的更晚痕迹 ⇒ replay_required（不能假装那是我们的写入）----
  // 必须先于快路径判定：首次结算也可能撞上「主体已被非结算路径动过」的局面
  // （legacy review / 手工写入），追加会静默埋没乱序证据。
  const unexplained = await findUnattributedNewerWrites(tx, {
    occurrenceMs,
    fsrsSubjects: plan.rating !== null ? plan.fsrsSubjects : [],
    thetaKcIds: plan.theta.applied ? plan.theta.knowledgeIds : [],
    abilityIds: plan.theta.applied ? Object.values(plan.theta.abilityGlobalByKnowledgeId) : [],
    reapplySet,
    liveIds: new Set(live.map((m) => m.id)),
  });
  if (unexplained !== null) {
    await writeReplayRequired(tx, {
      eventId: settlementEventId,
      plan,
      activatedAt,
      priorEffectiveEvaluationId: priorEffectiveId,
      detail: unexplained,
    });
    return 'failed_pending';
  }

  if (revertSet.length === 0 && !preserveUserRating) {
    const applied = await executePlan(tx, plan, settlementEventId, occurrenceAt);
    const effect: ActivationEffect =
      applied.fsrsApplied.length > 0 || applied.thetaApplied.length > 0 ? 'applied' : 'ineligible';
    await writeSettlementEvent(tx, {
      id: settlementEventId,
      plan,
      effect: effect === 'applied' ? 'applied' : 'ineligible',
      activatedAt,
      occurrenceAt,
      groupId: plan.groupId,
      submissionId: plan.submissionId,
      evaluationId: plan.evaluationId,
      priorEffectiveEvaluationId: priorEffectiveId,
      supersedesSettlementEventId: null,
      replayOf: null,
      revertedIds: [],
      appliedOutcome: applied,
    });
    return effect;
  }

  // ---- 有序 replay（单 savepoint：revert 最新→最旧 → apply 本结算 →
  //      re-apply 被 revert 成员按原 occurrence 升序）----
  const replayAppliedIds = new Map<string, string>(); // old event id → new event id
  let appliedOutcome: ApplyOutcome;
  try {
    appliedOutcome = await tx.transaction(async (sp): Promise<ApplyOutcome> => {
      for (const member of revertOrder) {
        const refusal = await revertSettlementMember(sp, member, {
          skipFsrsSegment: member.id === replacedMember?.id && preserveUserRating,
        });
        if (refusal !== null) {
          throw new ReplayRequiredError(refusal);
        }
      }
      const mine = await executePlan(sp, plan, settlementEventId, occurrenceAt, {
        skipFsrs: preserveUserRating,
      });
      for (const member of reapplySet) {
        const newIdFor = `stl_${createId()}`;
        // YUK-1093 P1-2 — re-apply 保真：原结算经守卫【跳过】了 FSRS（plan 有
        // rating 但 effects.fsrs_applied 为空 = 该事件从未写卡）；按原判输入
        // 重放时也必须跳过，否则重放会把用户保留的评级悄悄改写成 verdict
        // 评级 —— 同一守卫语义的 replay 面对偶。
        const memberSkippedFsrs = member.inputs.rating !== null && member.fsrsApplied.length === 0;
        const reOutcome = await executePlan(
          sp,
          member.inputs,
          newIdFor,
          new Date(member.occurrenceMs),
          { skipFsrs: memberSkippedFsrs },
        );
        replayAppliedIds.set(member.id, newIdFor);
        await writeSettlementEvent(sp, {
          id: newIdFor,
          plan: member.inputs,
          effect: 'applied',
          activatedAt,
          occurrenceAt: new Date(member.occurrenceMs),
          groupId: member.groupId,
          submissionId: member.inputs.submissionId,
          evaluationId: member.evaluationId,
          // re-apply 不伪造 supersede 关系：原成员链经 replay_of 指回。
          priorEffectiveEvaluationId: null,
          supersedesSettlementEventId: null,
          replayOf: member.id,
          revertedIds: [member.id],
          appliedOutcome: reOutcome,
        });
      }
      return mine;
    });
  } catch (err) {
    const detail: Record<string, unknown> =
      err instanceof ReplayRequiredError
        ? (err.detail as unknown as Record<string, unknown>)
        : { kind: 'reapply_failed', reason: err instanceof Error ? err.message : String(err) };
    await writeReplayRequired(tx, {
      eventId: settlementEventId,
      plan,
      activatedAt,
      priorEffectiveEvaluationId: priorEffectiveId,
      detail,
    });
    return 'failed_pending';
  }

  await writeSettlementEvent(tx, {
    id: settlementEventId,
    plan,
    effect: 'applied',
    activatedAt,
    occurrenceAt,
    groupId: plan.groupId,
    submissionId: plan.submissionId,
    evaluationId: plan.evaluationId,
    priorEffectiveEvaluationId: priorEffectiveId,
    supersedesSettlementEventId: replacedMember?.id ?? null,
    replayOf: null,
    revertedIds: revertOrder.map((m) => m.id),
    appliedOutcome,
  });
  return 'applied';
}

class ReplayRequiredError extends Error {
  constructor(public readonly detail: ReplayRequired) {
    super(`assessment settlement replay required: ${detail.kind}`);
    this.name = 'ReplayRequiredError';
  }
}

async function writeReplayRequired(
  tx: Tx,
  input: {
    eventId: string;
    plan: SettlementPlan | null;
    activatedAt: Date;
    priorEffectiveEvaluationId: string | null;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await writeSettlementEvent(tx, {
    id: input.eventId,
    plan: input.plan,
    effect: 'replay_required',
    activatedAt: input.activatedAt,
    occurrenceAt: input.plan ? new Date(input.plan.occurrenceAt) : null,
    groupId: input.plan?.groupId ?? 'unknown',
    submissionId: input.plan?.submissionId ?? 'unknown',
    evaluationId: input.plan?.evaluationId ?? 'unknown',
    priorEffectiveEvaluationId: input.priorEffectiveEvaluationId,
    supersedesSettlementEventId: null,
    replayOf: null,
    revertedIds: [],
    appliedOutcome: null,
    reasonDetail: { replay_required: input.detail },
  });
}

/**
 * D4 对偶 — user-rating provenance 回溯（YUK-1093 P1-2）。
 *
 * live FSRS 卡的【最后结算写入者】是 `material_fsrs_state.last_review_event_id`：
 * skip-FSRS 事件（前次守卫触发）从不写卡，自然不会出现在该字段上 —— 所以
 * 「沿 settlement 链回溯到最近真正落 FSRS 的事件」恰好落在这枚指针上，
 * supersedes/replay 链都已经由它浓缩（写者是 live 或 dead 均可，只看
 * rating_source）。本次结算若覆写这些主体中的任意一行，且该行的最后结算
 * 写入是 user rating（manual/self_report）⇒ 守卫成立。
 */
async function preservedUserRatingExists(
  tx: Tx,
  rows: SettlementEventRow[],
  subjectKeys: readonly string[],
): Promise<boolean> {
  if (subjectKeys.length === 0) return false;
  const ratingSourceById = new Map<string, SettlementPlan['ratingSource']>();
  for (const row of rows) {
    if (row.inputs !== null) ratingSourceById.set(row.id, row.inputs.ratingSource);
  }
  const wanted = new Map<string, string>();
  for (const key of subjectKeys) {
    const i = key.indexOf(':');
    if (i > 0) wanted.set(key.slice(i + 1), key.slice(0, i));
  }
  if (wanted.size === 0) return false;
  const fsrsRows = await tx
    .select({
      subject_kind: material_fsrs_state.subject_kind,
      subject_id: material_fsrs_state.subject_id,
      last_review_event_id: material_fsrs_state.last_review_event_id,
    })
    .from(material_fsrs_state)
    .where(
      and(
        inArray(material_fsrs_state.subject_kind, ['knowledge', 'question']),
        inArray(material_fsrs_state.subject_id, [...wanted.keys()]),
      ),
    );
  for (const row of fsrsRows) {
    if (wanted.get(row.subject_id) !== row.subject_kind) continue;
    const writer = row.last_review_event_id;
    if (writer !== null && ratingSourceById.get(writer) === 'user') return true;
  }
  return false;
}

/**
 * 非结算 writer 的更晚痕迹检测：我的写入主体上，任何 occurrence 之后的
 * 痕迹必须能归因到 replay 闭包成员（live 结算事件 / 其 occurrence）——
 * 否则那是【没法重放的更新证据】，fail-closed 到 replay_required。
 */
async function findUnattributedNewerWrites(
  tx: Tx,
  input: {
    occurrenceMs: number;
    /** 本次实际将写的 FSRS 主体（rating=null 时不写，不查）。 */
    fsrsSubjects: FsrsSubject[];
    /** 本次实际将写的 θ̂ KC（theta abstain 时不写，不查）。 */
    thetaKcIds: string[];
    /** 本次将写的 ability_global domain（θ̂ applied + hierarchical 时）。 */
    abilityIds: string[];
    reapplySet: AppliedSettlementEvent[];
    liveIds: Set<string>;
  },
): Promise<Record<string, unknown> | null> {
  const fsrsWanted = new Map<string, 'knowledge' | 'question'>();
  for (const s of input.fsrsSubjects) fsrsWanted.set(s.id, s.kind);

  const memberBySubjectAndOcc = new Map<string, AppliedSettlementEvent>();
  for (const m of input.reapplySet) {
    for (const s of m.subjects) memberBySubjectAndOcc.set(`${s}@${m.occurrenceMs}`, m);
  }

  if (fsrsWanted.size > 0) {
    const rows = await tx
      .select({
        subject_kind: material_fsrs_state.subject_kind,
        subject_id: material_fsrs_state.subject_id,
        state: material_fsrs_state.state,
        last_review_event_id: material_fsrs_state.last_review_event_id,
      })
      .from(material_fsrs_state)
      .where(
        and(
          inArray(material_fsrs_state.subject_kind, ['knowledge', 'question']),
          inArray(material_fsrs_state.subject_id, [...fsrsWanted.keys()]),
        ),
      );
    for (const row of rows) {
      if (fsrsWanted.get(row.subject_id) !== row.subject_kind) continue;
      const key = subjectKey(row.subject_kind, row.subject_id);
      const lastReview = coerceMs(
        (row.state as { last_review?: Date | string | null } | null)?.last_review ?? null,
      );
      if (lastReview === null || lastReview <= input.occurrenceMs) continue;
      const writer = row.last_review_event_id;
      if (writer !== null && input.liveIds.has(writer)) {
        const member = input.reapplySet.find((m) => m.id === writer);
        if (member && member.occurrenceMs === lastReview) continue;
      }
      return {
        kind: 'unattributed_newer_write',
        subject: key,
        detail: `material_fsrs_state.last_review ${new Date(lastReview).toISOString()} by '${writer ?? 'unknown'}'`,
      };
    }
  }

  if (input.thetaKcIds.length > 0) {
    const rows = await tx
      .select({
        subject_id: mastery_state.subject_id,
        lastOutcomeAt: mastery_state.last_outcome_at,
      })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, 'knowledge'),
          inArray(mastery_state.subject_id, input.thetaKcIds),
        ),
      );
    for (const row of rows) {
      const at = coerceMs(row.lastOutcomeAt);
      if (at === null || at <= input.occurrenceMs) continue;
      if (memberBySubjectAndOcc.has(`knowledge:${row.subject_id}@${at}`)) continue;
      return {
        kind: 'unattributed_newer_write',
        subject: `knowledge:${row.subject_id}`,
        detail: `mastery_state.last_outcome_at ${new Date(at).toISOString()}`,
      };
    }
  }
  if (input.abilityIds.length > 0) {
    const rows = await tx
      .select({
        subject_id: mastery_state.subject_id,
        lastOutcomeAt: mastery_state.last_outcome_at,
      })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, 'ability_global'),
          inArray(mastery_state.subject_id, input.abilityIds),
        ),
      );
    for (const row of rows) {
      const at = coerceMs(row.lastOutcomeAt);
      if (at === null || at <= input.occurrenceMs) continue;
      if (memberBySubjectAndOcc.has(`ability_global:${row.subject_id}@${at}`)) continue;
      return {
        kind: 'unattributed_newer_write',
        subject: `ability_global:${row.subject_id}`,
        detail: `mastery_state(ability_global).last_outcome_at ${new Date(at).toISOString()}`,
      };
    }
  }
  return null;
}
