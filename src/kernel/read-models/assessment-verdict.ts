// YUK-1054 — 双轨裁决读模型（grounding §9–§10 read-model 切分）。
//
// 所有「某次作答/评估最终判了什么」的消费面共享这一个 resolver：
//
//   LEGACY LANE（judge event 家族，action='judge' / subject_kind='event'）
//     锚定面（writer 已核实）：
//       - 判分 judge：  subject_id = attemptEventId AND caused_by = attemptEventId
//         （review-settlement.ts settleSoloReview :578-610 / settlePaperAttempt :993-1019）
//       - 申诉重判 judge：subject_id = attemptEventId（继承被改判 judge 的 subject），
//         caused_by = appeal.id（jobs/rejudge.ts :236-265 + correct supersede :268-285）
//       - 归因 judge：  subject_id = attemptEventId AND caused_by = attemptEventId
//         （failure-learning-attribution.ts :275-313）
//     ⇒ 拉取必须 subject_id ∪ caused_by 双通道：只查 caused_by 会漏掉申诉重判
//       （question-activity / failure-attempts 的历史 gap），只查 subject_id 会漏掉
//       假想 caused_by-only 锚。行分组键 = subject_id 命中 attemptIds 优先，否则
//       caused_by_event_id 命中项。
//
//     original 轨：该 attempt 的【第一条】judge event（created_at/dispatch_seq/id
//       最老）——历史第一判收据，永不因改判改写。
//     effective 轨：每条候选 judge 行跑 getEffectiveTruths 链解析，只留
//       terminal_state='active' 且 effective_event_id 指回同 action/subject_kind/
//       subject_id 的 live 行（镜像 failure-attempts.ts resolveEffectiveActiveRows），
//       取最新一条 —— 改判（supersede→新 judge）后 effective 指向新判。
//     newest_raw：纯 newest-wins 无视 correction 状态（旧消费面的既有语义），
//       供调用方判「是否被 supersede」差异。
//
//   CONTRACT LANE（evaluation_group_id 锚定）
//     effective = evaluation_effective_head.effective_evaluation_id 指向的
//       evaluation 行；original = 第一条 active
//       `experimental:assessment_activation` 事件的 evaluation_id（回退：最早
//       applied settlement 的 evaluation_id，再退 attempt=1 行）。verdict 经
//       deriveCoarseVerdict（需 submission.revision_id → question_revision.
//       scoring_basis）。今日无 live contract activation（EVALUATION_ENTRY_POINTS
//       全 lane:'legacy'）——本轨为前向接线，行为已由测试钉住。
//
// replay 结构性保证（read 侧约束）：settlement replay 只写
//   `experimental:assessment_settlement`（replay_of + reverted_settlement_event_ids
//   标记，liveAppliedSettlements 视被 replay 者为 dead），不写任何 attempt/judge/
//   mastery 事件 ⇒ 订阅链不会 refire，ingest_at 预填使 memory outbox 天然跳过，
//   actor_kind='system' 过不了 shouldExtractToMemory 的 user 门。本模块不依赖
//   replay 产生的新行做判定。

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { EvaluationRecordT } from '@/core/schema/assessment/judgment';
import type { ScoringBasisT } from '@/core/schema/assessment/scoring';
import {
  type AssessmentVerdict,
  type CoarseVerdict,
  deriveCoarseVerdict,
} from '@/core/schema/assessment/settlement';
import type { CauseSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import {
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  question_revision,
} from '@/db/schema';
import {
  type EffectiveTruth,
  activeEffectiveTruth,
  filterActiveRows,
  getEffectiveTruths,
  newerEventRow,
} from '@/kernel/events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
type EvaluationRow = typeof evaluation.$inferSelect;

// 任何 IN 列表的每查询参数上限。copilot nudge-triggers 把评估快照读封装为「每
// 查询 ≤104 参数」回归锚（nudge-streak.db.test.ts:caps parameters）；本 resolver
// 是共享读模型，必须在自己的 inArray 处做 chunk（getEffectiveTruths 的
// subject_id 拉取是最大爆点：单 attempt 可有数百 judge 行）。64 留出
// action/subject_kind 等字面量参数 headroom。
const QUERY_ID_CHUNK = 64;

// Wire action 常量 —— 与 writer 模块保持一致（src/server/assessment/activate.ts
// ASSESSMENT_ACTIVATION_ACTION / settle.ts ASSESSMENT_SETTLEMENT_ACTION）。本地
// 声明以避免把编排模块图拉进本读模型的 import 面；writer 改常量时必须同步。
const ASSESSMENT_ACTIVATION_ACTION = 'experimental:assessment_activation';
const ASSESSMENT_SETTLEMENT_ACTION = 'experimental:assessment_settlement';

// ============================================================================
// Legacy lane — judge-event 双轨投影
// ============================================================================

/** judge payload 中本读模型消费的字段（known.ts JudgeOnEvent 的读取侧子集）。 */
export interface JudgeVerdictPayload {
  coarse_outcome: string | null;
  score: number | null;
  feedback_md: string | null;
  visible_to_user: boolean | null;
  cause: CauseSchemaT | null;
  referenced_knowledge_ids: string[];
  judge_route: string | null;
  /** 申诉重判来源（payload.appeal_event_id，非 envelope 字段）。 */
  appeal_event_id: string | null;
  attribution_pending: boolean | null;
}

/** 一条 judge event 行 + 其链解析状态 + 规范化 payload 视图。 */
export interface JudgeVerdictProjection {
  judge_event_id: string;
  /** 该行在事件流里的原始 id；对 effective 投影 = 链端 effective 行 id。 */
  original_event_id: string;
  created_at: Date;
  /** original 行的链解析状态（effective 投影上 = 指向它的 original 链）。 */
  correction_state: EffectiveTruth;
  verdict: JudgeVerdictPayload;
  /** 原始行引用（消费面需要未投影字段时用）。 */
  row: EventRow;
}

export interface AttemptVerdict {
  attempt_event_id: string;
  /**
   * 执行期嵌入收据（attempt/review event 的 payload.judge）。solve-session
   * （YUK-193）等 lane 把判分嵌在 attempt payload 里、并不另写 judge event —
   * 「embedded grade」历史分歧（grounding §9 行），本轨显式保留它：无 judge
   * 行时它是唯一的判收据；有 judge 行时它仍代表「执行时写下的那一判」。
   */
  embedded: JudgeVerdictPayload | null;
  /** 历史第一判（最早 judge event 行）；无 judge 时 null。 */
  original: JudgeVerdictProjection | null;
  /** 当前生效判（链解析后最新 live judge）；全被 supersede/retract 时 null。 */
  effective: JudgeVerdictProjection | null;
  /** newest-wins 无视 correction（旧读面语义）；无 judge 时 null。 */
  newest_raw: JudgeVerdictProjection | null;
}

function judgePayloadFromRow(row: EventRow): JudgeVerdictPayload {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  return {
    coarse_outcome: typeof p.coarse_outcome === 'string' ? p.coarse_outcome : null,
    score: typeof p.score === 'number' ? p.score : null,
    feedback_md: typeof p.feedback_md === 'string' ? p.feedback_md : null,
    visible_to_user: typeof p.visible_to_user === 'boolean' ? p.visible_to_user : null,
    cause: (p.cause as CauseSchemaT | undefined) ?? null,
    referenced_knowledge_ids: Array.isArray(p.referenced_knowledge_ids)
      ? (p.referenced_knowledge_ids as string[])
      : [],
    judge_route: typeof p.judge_route === 'string' ? p.judge_route : null,
    appeal_event_id: typeof p.appeal_event_id === 'string' ? p.appeal_event_id : null,
    attribution_pending: typeof p.attribution_pending === 'boolean' ? p.attribution_pending : null,
  };
}

/**
 * embedded 判（attempt payload.judge）→ JudgeVerdictPayload。嵌入形状用
 * route/reason_md（solve-session responseJudge），不是 judge event 的
 * judge_route/feedback_md —— 字段映射，其余字段缺省为 null。
 */
function judgePayloadFromEmbedded(raw: unknown): JudgeVerdictPayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    coarse_outcome: typeof p.coarse_outcome === 'string' ? p.coarse_outcome : null,
    score: typeof p.score === 'number' ? p.score : null,
    feedback_md: typeof p.reason_md === 'string' ? p.reason_md : null,
    visible_to_user: typeof p.visible_to_user === 'boolean' ? p.visible_to_user : null,
    cause: (p.cause as CauseSchemaT | undefined) ?? null,
    referenced_knowledge_ids: Array.isArray(p.referenced_knowledge_ids)
      ? (p.referenced_knowledge_ids as string[])
      : [],
    judge_route:
      typeof p.judge_route === 'string'
        ? p.judge_route
        : typeof p.route === 'string'
          ? p.route
          : null,
    appeal_event_id: null,
    attribution_pending: null,
  };
}

/** 行 → attempt 锚分组键：subject_id 命中优先，否则 caused_by_event_id 命中。 */
function attemptAnchorKey(row: EventRow, attemptIds: Set<string>): string | null {
  if (row.subject_id !== null && attemptIds.has(row.subject_id)) return row.subject_id;
  if (row.caused_by_event_id !== null && attemptIds.has(row.caused_by_event_id)) {
    return row.caused_by_event_id;
  }
  return null;
}

async function rowsById(db: DbLike, ids: string[]): Promise<Map<string, EventRow>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const out = new Map<string, EventRow>();
  for (let offset = 0; offset < uniqueIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + QUERY_ID_CHUNK);
    const rows = await db.select().from(event).where(inArray(event.id, chunk));
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

// 并发安全批链解析：candidate id 列表分块喂 getEffectiveTruths。单调用方
// 一次调 4 个 inArray(事件 id) —— 分块后每查询 ≤64 ids（cap 104，含字面量）。
async function effectiveTruthsChunked(
  db: DbLike,
  eventIds: string[],
): Promise<Map<string, EffectiveTruth>> {
  const uniqueIds = [...new Set(eventIds)];
  const out = new Map<string, EffectiveTruth>();
  for (let offset = 0; offset < uniqueIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + QUERY_ID_CHUNK);
    for (const [id, truth] of await getEffectiveTruths(db, chunk)) out.set(id, truth);
  }
  return out;
}

// judge 候选行双通道拉取（subject_id ∪ caused_by）。分两查询各自 chunk——
// or(inArray,inArray) 单语句把两通道的 id 都塞进同一次参数计数，是 104-cap
// 违规最快路径；拆分后每查询只带一条 ≤64 的 IN 列表。
async function judgeCandidatesForAttempts(db: DbLike, attemptIds: string[]): Promise<EventRow[]> {
  const uniqueIds = [...new Set(attemptIds)];
  const byId = new Map<string, EventRow>();
  for (let offset = 0; offset < uniqueIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + QUERY_ID_CHUNK);
    const [bySubject, byCausedBy] = await Promise.all([
      db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'judge'),
            eq(event.subject_kind, 'event'),
            inArray(event.subject_id, chunk),
          ),
        ),
      db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'judge'),
            eq(event.subject_kind, 'event'),
            inArray(event.caused_by_event_id, chunk),
          ),
        ),
    ]);
    for (const row of bySubject) byId.set(row.id, row);
    for (const row of byCausedBy) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/**
 * 批量解析一批 attempt/review event 的 original/effective/newest_raw 三轨裁决。
 * 单次调用固定 3 个 round-trip（候选拉取 + 链解析 + effective 行回填）。
 */
export async function resolveVerdictsForAttempts(
  db: DbLike,
  attemptIds: string[],
): Promise<Map<string, AttemptVerdict>> {
  const uniqueIds = [...new Set(attemptIds)];
  const out = new Map<string, AttemptVerdict>();
  for (const id of uniqueIds) {
    out.set(id, {
      attempt_event_id: id,
      embedded: null,
      original: null,
      effective: null,
      newest_raw: null,
    });
  }
  if (uniqueIds.length === 0) return out;

  // embedded 轨：attempt 行自身 payload.judge（solve-session 等 embedded-grade
  // 分歧面）。只在 attempt 行确实存在、且 payload.judge 是非空对象时填。
  const attemptRows = await rowsById(db, uniqueIds);
  for (const [id, row] of attemptRows) {
    const entry = out.get(id);
    if (!entry) continue;
    const judge = (row.payload ?? {}) as Record<string, unknown>;
    const embedded = judge.judge;
    if (embedded !== null && typeof embedded === 'object') {
      entry.embedded = judgePayloadFromEmbedded(embedded);
    }
  }

  const anchorSet = new Set(uniqueIds);
  const candidates = await judgeCandidatesForAttempts(db, uniqueIds);
  if (candidates.length === 0) return out;

  // 链解析：每条候选 original 行 → effective 行。
  const truthByOriginal = await effectiveTruthsChunked(
    db,
    candidates.map((row) => row.id),
  );
  const rowById = new Map(candidates.map((row) => [row.id, row]));
  const missingEffectiveIds = [...truthByOriginal.values()]
    .map((truth) => truth.effective_event_id)
    .filter((id): id is string => typeof id === 'string' && !rowById.has(id));
  for (const [id, row] of await rowsById(db, missingEffectiveIds)) {
    rowById.set(id, row);
  }

  // per-attempt 聚合：original = 最早候选行；newest_raw = 最新候选行；
  // effective = 链解析后仍 live（terminal active + effective 行锚一致）里的最新行。
  type Acc = {
    original: EventRow | null;
    newestRaw: EventRow | null;
    effective: { row: EventRow; truth: EffectiveTruth } | null;
  };
  const byAttempt = new Map<string, Acc>();
  const accFor = (key: string): Acc => {
    let acc = byAttempt.get(key);
    if (!acc) {
      acc = { original: null, newestRaw: null, effective: null };
      byAttempt.set(key, acc);
    }
    return acc;
  };

  for (const row of candidates) {
    const key = attemptAnchorKey(row, anchorSet);
    if (key === null) continue;
    const acc = accFor(key);
    // original 取最老：acc.original 为空或 row 不比它新（!newerEventRow）则替换。
    if (acc.original === null || !newerEventRow(row, acc.original)) {
      acc.original = row;
    }
    if (acc.newestRaw === null || newerEventRow(row, acc.newestRaw)) {
      acc.newestRaw = row;
    }

    const truth = truthByOriginal.get(row.id) ?? activeEffectiveTruth(row.id);
    if (truth.terminal_state !== 'active' || !truth.effective_event_id) continue;
    const effectiveRow = rowById.get(truth.effective_event_id);
    if (!effectiveRow) continue;
    // 镜像 resolveEffectiveActiveRows：锚一致性只比 action/subject_kind/
    // subject_id（不比 caused_by —— rejudge 的 caused_by=appeal.id 合法）。
    if (effectiveRow.action !== row.action) continue;
    if (effectiveRow.subject_kind !== row.subject_kind) continue;
    if (effectiveRow.subject_id !== row.subject_id) continue;
    if (!acc.effective || newerEventRow(effectiveRow, acc.effective.row)) {
      acc.effective = { row: effectiveRow, truth };
    }
  }

  for (const [key, acc] of byAttempt) {
    out.set(key, {
      attempt_event_id: key,
      embedded: out.get(key)?.embedded ?? null,
      original:
        acc.original === null
          ? null
          : {
              judge_event_id: acc.original.id,
              original_event_id: acc.original.id,
              created_at: acc.original.created_at,
              correction_state:
                truthByOriginal.get(acc.original.id) ?? activeEffectiveTruth(acc.original.id),
              verdict: judgePayloadFromRow(acc.original),
              row: acc.original,
            },
      effective: acc.effective
        ? {
            judge_event_id: acc.effective.row.id,
            original_event_id: acc.effective.truth.original_event_id,
            created_at: acc.effective.row.created_at,
            correction_state: acc.effective.truth,
            verdict: judgePayloadFromRow(acc.effective.row),
            row: acc.effective.row,
          }
        : null,
      newest_raw:
        acc.newestRaw === null
          ? null
          : {
              judge_event_id: acc.newestRaw.id,
              original_event_id: acc.newestRaw.id,
              created_at: acc.newestRaw.created_at,
              correction_state:
                truthByOriginal.get(acc.newestRaw.id) ?? activeEffectiveTruth(acc.newestRaw.id),
              verdict: judgePayloadFromRow(acc.newestRaw),
              row: acc.newestRaw,
            },
    });
  }
  return out;
}

/** 单 id 便捷封装。 */
export async function resolveVerdictForAttempt(
  db: DbLike,
  attemptEventId: string,
): Promise<AttemptVerdict> {
  const map = await resolveVerdictsForAttempts(db, [attemptEventId]);
  return (
    map.get(attemptEventId) ?? {
      attempt_event_id: attemptEventId,
      embedded: null,
      original: null,
      effective: null,
      newest_raw: null,
    }
  );
}

// ============================================================================
// Contract lane — evaluation_group 双轨投影
// ============================================================================

export interface EvaluationVerdict {
  evaluation_id: string;
  /** evaluation.attempt（重试序号）。 */
  attempt: number;
  status: EvaluationRecordT['status'];
  verdict: CoarseVerdict;
  row: EvaluationRow;
}

export interface GroupVerdict {
  evaluation_group_id: string;
  /** head 指向的当前生效 evaluation + verdict；head 缺行/effective NULL ⇒ null。 */
  effective: EvaluationVerdict | null;
  /** 第一条 activation 生效的 evaluation + verdict；从未激活 ⇒ null。 */
  original: EvaluationVerdict | null;
  /** head 行（含 generation）；无 head ⇒ null。 */
  head: typeof evaluation_effective_head.$inferSelect | null;
}

/**
 * 批量解析 evaluation_group 的 original/effective 裁决。
 * verdict 经 deriveCoarseVerdict（basis 来自 submission.revision_id →
 * question_revision.scoring_basis；缺 revision/basis ⇒ verdict=null，如实
 * 返回行不造判定 —— deriveCoarseVerdict 不处理「无 basis」面，调用方拿
 * verdict=null 当 unsupported 语义处理）。
 */
export async function resolveVerdictsForGroups(
  db: DbLike,
  groupIds: string[],
): Promise<Map<string, GroupVerdict>> {
  const uniqueIds = [...new Set(groupIds)];
  const out = new Map<string, GroupVerdict>();
  for (const id of uniqueIds) {
    out.set(id, { evaluation_group_id: id, effective: null, original: null, head: null });
  }
  if (uniqueIds.length === 0) return out;

  // 每 inArray 分组 id 都走 chunk（同 QUERY_ID_CHUNK）；五路独立 round-trip。
  const heads: (typeof evaluation_effective_head.$inferSelect)[] = [];
  const evalRows: EvaluationRow[] = [];
  const submissions: (typeof assessment_submission.$inferSelect)[] = [];
  const activationRows: EventRow[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + QUERY_ID_CHUNK);
    const [h, ev, sub, act] = await Promise.all([
      db
        .select()
        .from(evaluation_effective_head)
        .where(inArray(evaluation_effective_head.evaluation_group_id, chunk)),
      db.select().from(evaluation).where(inArray(evaluation.evaluation_group_id, chunk)),
      db
        .select()
        .from(assessment_submission)
        .where(inArray(assessment_submission.evaluation_group_id, chunk)),
      db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, ASSESSMENT_ACTIVATION_ACTION),
            eq(event.subject_kind, 'evaluation_group'),
            inArray(event.subject_id, chunk),
          ),
        )
        .orderBy(asc(event.created_at), asc(event.id)),
    ]);
    heads.push(...h);
    evalRows.push(...ev);
    submissions.push(...sub);
    activationRows.push(...act);
  }
  // settlement 拉取不分组（action 扫描，非 inArray）——块外单跑，避免每 chunk
  // 重复拉同一全集。original 轨只需「组内最早 applied」，行数小，接受 action-scan。
  const settlementRows = await db
    .select({ id: event.id, created_at: event.created_at, payload: event.payload })
    .from(event)
    .where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));

  const headByGroup = new Map(heads.map((h) => [h.evaluation_group_id, h]));
  const evalById = new Map(evalRows.map((r) => [r.evaluation_id, r]));
  const evalsByGroup = new Map<string, EvaluationRow[]>();
  for (const row of evalRows) {
    const list = evalsByGroup.get(row.evaluation_group_id) ?? [];
    list.push(row);
    evalsByGroup.set(row.evaluation_group_id, list);
  }
  const subById = new Map(submissions.map((s) => [s.submission_id, s]));

  // revision basis：submission.revision_id → question_revision.scoring_basis。
  const revisionIds = [...new Set(submissions.map((s) => s.revision_id))];
  const revisionRows: { revision_id: string; scoring_basis: unknown }[] = [];
  for (let offset = 0; offset < revisionIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = revisionIds.slice(offset, offset + QUERY_ID_CHUNK);
    const rows = await db
      .select({
        revision_id: question_revision.revision_id,
        scoring_basis: question_revision.scoring_basis,
      })
      .from(question_revision)
      .where(inArray(question_revision.revision_id, chunk));
    revisionRows.push(...rows);
  }
  const basisByRevision = new Map(revisionRows.map((r) => [r.revision_id, r.scoring_basis]));

  // original 轨：第一条 active activation 事件的 evaluation_id（retract 的
  // activation 收据不算「第一判生效」）。
  const activeActivationRows = await filterActiveRows(db, activationRows);
  const firstActivationByGroup = new Map<string, string>();
  for (const row of activeActivationRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const evalId = typeof p.evaluation_id === 'string' ? p.evaluation_id : null;
    if (evalId === null) continue;
    // activationRows 已按 (created_at, id) 升序 —— 首见即最早。
    if (!firstActivationByGroup.has(row.subject_id)) {
      firstActivationByGroup.set(row.subject_id, evalId);
    }
  }
  // 回退：最早 applied settlement 的 evaluation_id（结算事件载荷含
  // evaluation_group_id + evaluation_id + effect；replay/supersede 关系不在
  // original 轨语义内 —— original 是「第一判」而非「当前 live」，取最早的
  // applied 行即可）。
  const firstSettlementEvalByGroup = new Map<string, string>();
  const sortedSettlementRows = [...settlementRows].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id),
  );
  for (const row of sortedSettlementRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (p.effect !== 'applied') continue;
    const groupId = typeof p.evaluation_group_id === 'string' ? p.evaluation_group_id : null;
    const evalId = typeof p.evaluation_id === 'string' ? p.evaluation_id : null;
    if (groupId === null || evalId === null) continue;
    if (!firstSettlementEvalByGroup.has(groupId)) {
      firstSettlementEvalByGroup.set(groupId, evalId);
    }
  }

  const project = (row: EvaluationRow): EvaluationVerdict | null => {
    const sub = subById.get(row.submission_id);
    const basis = sub
      ? (basisByRevision.get(sub.revision_id) as ScoringBasisT | undefined)
      : undefined;
    return {
      evaluation_id: row.evaluation_id,
      attempt: row.attempt,
      status: row.status,
      verdict: basis
        ? deriveCoarseVerdict({ status: row.status, aggregate: row.aggregate }, basis)
        : // 无 basis 无法派生 —— 如实回 unsupported/pending 面，不造判定。
          {
            verdict: 'unsupported' as AssessmentVerdict,
            reason: 'evaluation_pending' as const,
            points: null,
            maxPoints: null,
            normalized: null,
          },
      row,
    };
  };

  for (const groupId of uniqueIds) {
    const entry = out.get(groupId) as GroupVerdict;
    const head = headByGroup.get(groupId) ?? null;
    entry.head = head;

    if (head?.effective_evaluation_id) {
      const effectiveRow = evalById.get(head.effective_evaluation_id);
      if (effectiveRow) entry.effective = project(effectiveRow);
    }

    const originalEvalId =
      firstActivationByGroup.get(groupId) ?? firstSettlementEvalByGroup.get(groupId) ?? null;
    if (originalEvalId !== null) {
      const originalRow = evalById.get(originalEvalId);
      if (originalRow) entry.original = project(originalRow);
    }
    if (entry.original === null) {
      // 再退：组内最早 attempt 序（attempt=1 优先，否则最小 attempt）。
      const groupEvals = evalsByGroup.get(groupId) ?? [];
      const earliest = [...groupEvals].sort(
        (a, b) =>
          a.attempt - b.attempt ||
          a.created_at.getTime() - b.created_at.getTime() ||
          a.evaluation_id.localeCompare(b.evaluation_id),
      )[0];
      if (earliest) entry.original = project(earliest);
    }
  }
  return out;
}

/** 单 group 便捷封装。 */
export async function resolveVerdictForGroup(db: DbLike, groupId: string): Promise<GroupVerdict> {
  const map = await resolveVerdictsForGroups(db, [groupId]);
  return (
    map.get(groupId) ?? {
      evaluation_group_id: groupId,
      effective: null,
      original: null,
      head: null,
    }
  );
}
