// 只读诊断端口：从既有作答/判分/错因/misconception 证据派生「可行动薄弱点」落点列表
// （YUK-1582）。派生即读，不落库、不写回掌握/调度状态；证据不足时显式输出 unknown，
// 不编造整块比例。
//
// 复用的真相源（不建平行真相）：
//   - getFailureAttempts —— 失败 attempt/review + 链式 judge/user_cause 归因（含纠正态）。
//   - subject profile —— cause 类目的 meta_cause_prior（冷启动先验）与人读 label。
//   - misconception（deterministic identity 匹配）—— owner 已接受的软轨误区与硬确认
//     （source='hard'，探针证据）只做强度升级；身份 id 约定在 core/schema/misconception.ts。
//
// 派生状态机（每条窗口内失败）：
//   失败 attempt ──无 active 归因──────────────→ unknown(no_active_attribution)
//             └─meta 解析失败（实例缺失且无 prior）→ unknown(meta_cause_unresolved)
//             └─meta = execution_slip───────────→ unknown(slip_only_failures)（处方是提示自查，不是训练）
//             └─meta 可行动 ──有 KC 引用────────→ 落点格(meta × cause × KC)
//                           └─无任何 KC 引用────→ 落点格(meta × cause × null KC)（knowledge_id=null 仅此路径）
//   落点格 → ActionableWeakPoint（kind/destination 取 WEAK_POINT_LANDING_RULES）
//            强度 = probe_confirmed（同身份 hard misconception）＞ recurring（≥2 次独立失败或
//            live soft misconception）＞ single_failure。
//
// 与 YUK-1584 的边界：本端口刻意不读掌握结论（p(L)/θ/FSRS），落点是定性证据折叠结果；
// 需要掌握读数的消费方走 readLearnerJudgments。

import { and, eq, inArray, isNull } from 'drizzle-orm';

import {
  type CauseCategoryT,
  type CauseProfileLike,
  type CauseSchemaT,
  type MetaCauseT,
  getCauseLabel,
  getMetaCausePrior,
} from '@/core/schema/cause';
import { misconceptionIdForConjecture } from '@/core/schema/misconception';
import {
  type ActionableMetaCause,
  type ActionableWeakPointDerivationT,
  type ActionableWeakPointT,
  WEAK_POINT_LANDING_RULES,
  type WeakPointEvidenceRefT,
  type WeakPointUnknownReasonT,
  type WeakPointUnknownSummaryT,
  weakPointKey,
} from '@/core/schema/weak-point';
import type { Db, Tx } from '@/db/client';
import { knowledge, misconception, misconception_edge } from '@/db/schema';
import { type FailureAttempt, getFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { batchResolveEffectiveDomains } from '@/kernel/read-models/knowledge-tree';
import { resolveSubjectProfile } from '@/subjects/profile';

type DbLike = Db | Tx;

/** 默认回看窗口：薄弱点信号取近 30 天失败（研究例会取 14 天是为了提案新鲜度，此处是训练去向）。 */
export const WEAK_POINT_WINDOW_DAYS = 30;
/** 单次派生最多扫描的失败条数（有界读取，超出部分留给下一轮）。 */
export const WEAK_POINT_SCAN_LIMIT = 200;
/** 返回落点上限；排序为强度带 → 独立失败数 → 最近一次失败。 */
export const WEAK_POINT_MAX_RESULTS = 12;
/** 每个落点携带的证据引用上限（保序截断，attempt 优先保留）。 */
export const WEAK_POINT_MAX_EVIDENCE_REFS = 6;

export interface DeriveActionableWeakPointsInput {
  since?: Date;
  now?: Date;
  scanLimit?: number;
  maxResults?: number;
}

interface CellAccumulator {
  meta_cause: ActionableMetaCause;
  cause_category: CauseCategoryT;
  knowledge_id: string | null;
  attemptIds: Map<string, true>;
  refs: Map<string, WeakPointEvidenceRefT>;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** user_cause 优先于 judge（用户对归因有最后发言权）；与 conjecture 证据面的读法一致。 */
function effectiveCause(
  failure: FailureAttempt,
): { category: CauseCategoryT; judgeCause: CauseSchemaT | null } | null {
  if (failure.user_cause) {
    // user_cause 无 meta 字段；若同 attempt 的 judge 类目一致，允许沿用其实例级 meta。
    const judgeCause = failure.judge ?? null;
    return {
      category: failure.user_cause.primary_category,
      judgeCause:
        judgeCause && judgeCause.cause.primary_category === failure.user_cause.primary_category
          ? judgeCause.cause
          : null,
    };
  }
  if (failure.judge) {
    return { category: failure.judge.cause.primary_category, judgeCause: failure.judge.cause };
  }
  return null;
}

function resolveMetaCause(
  cause: { category: CauseCategoryT; judgeCause: CauseSchemaT | null },
  profile: CauseProfileLike | null,
): MetaCauseT | null {
  if (cause.judgeCause?.meta_cause) return cause.judgeCause.meta_cause;
  return getMetaCausePrior(profile, cause.category);
}

function strengthRank(value: ActionableWeakPointT['evidence_strength']): number {
  if (value === 'probe_confirmed') return 3;
  if (value === 'recurring') return 2;
  return 1;
}

function appendRef(refs: Map<string, WeakPointEvidenceRefT>, ref: WeakPointEvidenceRefT): void {
  if (!refs.has(ref.event_id)) refs.set(ref.event_id, ref);
}

function composeTargetMd(input: {
  goalMd: string;
  aspectMd: string;
  knowledgeName: string | null;
  knowledgeId: string | null;
  causeLabel: string;
  failureCount: number;
}): string {
  const target = input.knowledgeName
    ? `「${input.knowledgeName}」中`
    : input.knowledgeId
      ? `知识点 ${input.knowledgeId} 中`
      : '（未挂知识点的失败簇——先补知识点标注，再训练）';
  const evidence = `${input.causeLabel}，${input.failureCount} 次独立失败`;
  return `${input.goalMd}${target}的${input.aspectMd}（证据：${evidence}）`;
}

/**
 * 派生可行动薄弱点。纯读：一次有界失败扫描 + 批量 KC 元数据 + 每域一次 profile 解析 +
 * 一次 live misconception 匹配。任何子步骤失败都不编造落点——抛错由调用方处理。
 */
export async function deriveActionableWeakPoints(
  db: DbLike,
  input: DeriveActionableWeakPointsInput = {},
): Promise<ActionableWeakPointDerivationT> {
  const now = input.now ?? new Date();
  const since =
    input.since ?? new Date(now.getTime() - WEAK_POINT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const scanLimit = input.scanLimit ?? WEAK_POINT_SCAN_LIMIT;
  const maxResults = input.maxResults ?? WEAK_POINT_MAX_RESULTS;

  const failures = await getFailureAttempts(db, {
    since,
    includeReviewFailures: true,
    limit: scanLimit,
  });

  const unknownCounts = new Map<WeakPointUnknownReasonT, { count: number; samples: string[] }>();
  const recordUnknown = (reason: WeakPointUnknownReasonT, attemptEventId: string) => {
    const bucket = unknownCounts.get(reason) ?? { count: 0, samples: [] };
    bucket.count += 1;
    if (bucket.samples.length < 3) bucket.samples.push(attemptEventId);
    unknownCounts.set(reason, bucket);
  };
  const referencedKnowledgeIds = (failure: FailureAttempt): string[] => [
    ...new Set(failure.referenced_knowledge_ids.filter((id) => id.length > 0)),
  ];

  // 第一遍：预解析每个失败的有效归因与 KC 引用，收集待查元数据的 KC 集合。
  const pendingKnowledgeIds = new Set<string>();
  const effectiveCauses = failures.map((failure) => ({
    failure,
    knowledgeIds: referencedKnowledgeIds(failure),
    cause: effectiveCause(failure),
  }));
  for (const entry of effectiveCauses) {
    if (entry.cause === null)
      recordUnknown('no_active_attribution', entry.failure.attempt_event_id);
    for (const id of entry.knowledgeIds) pendingKnowledgeIds.add(id);
  }

  // KC 元数据 + 域解析 + 每域 profile（prior/label 的来源）。
  const cells = new Map<string, CellAccumulator>();
  const knowledgeIds = [...pendingKnowledgeIds];
  const [nameById, domains] = await Promise.all([
    knowledgeIds.length === 0
      ? Promise.resolve(new Map<string, string>())
      : (async () => {
          const rows = await db
            .select({ id: knowledge.id, name: knowledge.name })
            .from(knowledge)
            .where(inArray(knowledge.id, knowledgeIds));
          return new Map(rows.map((row) => [row.id, row.name] as const));
        })(),
    batchResolveEffectiveDomains(db, knowledgeIds),
  ]);
  const profileByDomain = new Map<string, CauseProfileLike>();
  const profileFor = (knowledgeId: string | null): CauseProfileLike | null => {
    if (knowledgeId === null) return null;
    const domain = domains.get(knowledgeId) ?? null;
    if (domain === null) return null;
    let profile = profileByDomain.get(domain);
    if (profile === undefined) {
      profile = resolveSubjectProfile(domain);
      profileByDomain.set(domain, profile);
    }
    return profile;
  };

  // 第二遍：解析 meta，折叠格。
  for (const { failure, knowledgeIds: failureKnowledgeIds, cause } of effectiveCauses) {
    if (cause === null) continue; // 已在第一遍记 unknown
    const profile = profileFor(failureKnowledgeIds[0] ?? null);
    const meta = resolveMetaCause(cause, profile);
    if (meta === null) {
      recordUnknown('meta_cause_unresolved', failure.attempt_event_id);
      continue;
    }
    if (meta === 'execution_slip') {
      recordUnknown('slip_only_failures', failure.attempt_event_id);
      continue;
    }
    const targets: Array<string | null> =
      failureKnowledgeIds.length > 0 ? failureKnowledgeIds : [null];
    for (const knowledgeId of targets) {
      const key = weakPointKey(meta, cause.category, knowledgeId);
      const cell =
        cells.get(key) ??
        ({
          meta_cause: meta,
          cause_category: cause.category,
          knowledge_id: knowledgeId,
          attemptIds: new Map<string, true>(),
          refs: new Map<string, WeakPointEvidenceRefT>(),
          firstSeenAt: failure.created_at,
          lastSeenAt: failure.created_at,
        } satisfies CellAccumulator);
      cell.attemptIds.set(failure.attempt_event_id, true);
      appendRef(cell.refs, { event_id: failure.attempt_event_id, role: 'failed_attempt' });
      if (failure.judge) {
        appendRef(cell.refs, {
          event_id: failure.judge.judge_event_id,
          role: 'judge_attribution',
        });
      }
      if (failure.user_cause) {
        appendRef(cell.refs, {
          event_id: failure.user_cause.user_cause_event_id,
          role: 'user_cause_attribution',
        });
      }
      if (failure.created_at < cell.firstSeenAt) cell.firstSeenAt = failure.created_at;
      if (failure.created_at > cell.lastSeenAt) cell.lastSeenAt = failure.created_at;
      cells.set(key, cell);
    }
  }

  // live misconception 匹配：同身份（cause × KC）被 owner 接受的误区做强度升级，
  // 其 evidence 数组（一手 attempt 事件指针）并入证据引用。
  const liveMisconceptionById = new Map<string, { source: string; evidence: string[] }>();
  const cellKnowledgeIds = [
    ...new Set(
      [...cells.values()].flatMap((cell) => (cell.knowledge_id ? [cell.knowledge_id] : [])),
    ),
  ];
  if (cellKnowledgeIds.length > 0) {
    const rows = await db
      .select({
        id: misconception.id,
        source: misconception.source,
        evidence: misconception.evidence,
      })
      .from(misconception_edge)
      .innerJoin(misconception, eq(misconception.id, misconception_edge.from_id))
      .where(
        and(
          eq(misconception_edge.from_kind, 'misconception'),
          eq(misconception_edge.to_kind, 'knowledge'),
          eq(misconception_edge.relation_type, 'caused_by'),
          inArray(misconception_edge.to_id, cellKnowledgeIds),
          isNull(misconception_edge.archived_at),
          isNull(misconception.archived_at),
          eq(misconception.status, 'active'),
        ),
      );
    for (const row of rows) {
      liveMisconceptionById.set(row.id, { source: row.source, evidence: row.evidence ?? [] });
    }
  }

  const weakPoints: ActionableWeakPointT[] = [];
  for (const cell of cells.values()) {
    const rule = WEAK_POINT_LANDING_RULES[cell.meta_cause];
    const knowledgeId = cell.knowledge_id;
    const misconceptionRef =
      knowledgeId === null
        ? undefined
        : liveMisconceptionById.get(misconceptionIdForConjecture(cell.cause_category, knowledgeId));
    const failureCount = cell.attemptIds.size;
    let strength: ActionableWeakPointT['evidence_strength'] =
      failureCount >= 2 ? 'recurring' : 'single_failure';
    if (misconceptionRef) {
      // 软轨 = owner 接受的方向性先验（提案复发 ≥2）；硬轨 = 探针确认。
      if (misconceptionRef.source === 'hard') strength = 'probe_confirmed';
      else if (strength === 'single_failure') strength = 'recurring';
      for (const eventId of misconceptionRef.evidence) {
        appendRef(cell.refs, { event_id: eventId, role: 'failed_attempt' });
      }
    }
    // failure_count 保持窗口内可复现数；misconception 带来的额外证据只进 refs 与强度带。
    const profile = profileFor(knowledgeId);
    const knowledgeName = knowledgeId === null ? null : (nameById.get(knowledgeId) ?? null);
    const causeLabel = getCauseLabel(cell.cause_category, profile ?? undefined);
    const refs = [...cell.refs.values()].slice(0, WEAK_POINT_MAX_EVIDENCE_REFS);
    weakPoints.push({
      kind: rule.kind,
      knowledge_id: knowledgeId,
      knowledge_name: knowledgeName,
      target_md: composeTargetMd({
        goalMd: rule.goal_md,
        aspectMd: rule.aspect_md,
        knowledgeName,
        knowledgeId,
        causeLabel,
        failureCount,
      }),
      cause_category: cell.cause_category,
      cause_label: causeLabel,
      meta_cause: cell.meta_cause,
      training_destination: rule.destination,
      evidence_refs: refs,
      failure_count: failureCount,
      evidence_strength: strength,
      first_seen_at: cell.firstSeenAt,
      last_seen_at: cell.lastSeenAt,
    });
  }

  weakPoints.sort(
    (a, b) =>
      strengthRank(b.evidence_strength) - strengthRank(a.evidence_strength) ||
      b.failure_count - a.failure_count ||
      b.last_seen_at.getTime() - a.last_seen_at.getTime() ||
      (a.knowledge_id ?? '').localeCompare(b.knowledge_id ?? ''),
  );

  const unknowns: WeakPointUnknownSummaryT[] = [...unknownCounts.entries()].map(
    ([reason, bucket]) => ({
      reason,
      failure_count: bucket.count,
      sample_event_ids: bucket.samples,
    }),
  );
  unknowns.sort((a, b) => b.failure_count - a.failure_count || a.reason.localeCompare(b.reason));

  return {
    as_of: now,
    window_since: since,
    scanned_failure_count: failures.length,
    weak_points: weakPoints.slice(0, maxResults),
    unknowns,
  };
}
