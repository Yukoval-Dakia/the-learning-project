// Daily stream IO shell: materialize StreamPlan and orchestrate reads/advances.
// Pure selection lives in stream-composer.ts; candidate inputs in stream-inputs.ts;
// projections in stream-view.ts.

import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getConfig } from '@/core/config/store';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import { event, knowledge, learning_session, practice_stream_item, question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import { Review } from '@/server/session';
import { type CollectedSignal, collectCandidateSignals } from './candidate-signals';
import { DEFAULT_COMPOSE_LOCK_WAIT_MS, withinComposePaidWorkLock } from './compose-paid-work-lock';
import { readQuestionPace } from './question-pace';
// 取题瞬间动态供题 refill（池见底补题）。compose 后 best-effort 调用，flag-off 默认 no-op。
import { type RefillDeps, refillActiveLearningPools } from './question-supply/refill';
import {
  DEFAULT_SELECTION_POLICY,
  DEFAULT_TEMPERATURE,
  type SelectionPolicyConfig,
} from './selection-constants';
import {
  type SelectionObservationInput,
  recordSelectionObservation,
} from './selection-observations';
import { sampleByWeight } from './selection-sampler';
import {
  type ComposeSoftmaxDeps,
  type ComposeSoftmaxResult,
  composeSoftmaxStream,
  statisticalWeights,
} from './softmax-selection';
import { estimateStreamItemMinutes, fitStreamToTimeBudget } from './stream-budget';
import { type ComposerInputs, type StreamPlan, composeDailyStream } from './stream-composer';
import { collectComposerInputs, resolveDailyPracticeBudget } from './stream-inputs';
import { presentNonDueQuestion } from './stream-item-presentation';
import { readStreamSelectionCandidates } from './stream-selection-candidates';
import {
  type StreamScope,
  type StreamView,
  buildStreamView,
  filterProspectiveStreamQuestions,
} from './stream-view';

export { streamLocalDate } from './stream-date';
// 候选收集 / 预算解析已迁 stream-inputs.ts，视图类型与单行投影已迁
// stream-view.ts；以下 reexport 保持本模块既有导出面不变（既有消费者与测试的
// import 路径不动）。
export {
  VARIANT_INPUT_LIMIT,
  collectComposerInputs,
  resolveDailyPracticeBudget,
} from './stream-inputs';
export type { StreamScope, StreamView } from './stream-view';
export { getStreamViewItem } from './stream-view';

export type StreamItemRow = typeof practice_stream_item.$inferSelect;
export type StreamItemStatus = StreamItemRow['status'];

/** 本模块的 DB 句柄：既可是顶层 `db`，也可是事务内 `tx`。 */
type DbLike = Db | Tx;

/**
 * `practice_stream_item` now has two physical partitions in one table:
 * - session_id IS NULL: the existing whole-profile daily stream;
 * - session_id = <review session>: an independent KC-scoped on-demand stream.
 *
 * Every date-only daily query must use this predicate. A bare `date = …` would leak scoped
 * progress into the daily stream and could make lazy-compose falsely think the day is ready.
 */
function streamPartitionPredicate(date: string, sessionId?: string | null) {
  return sessionId
    ? and(eq(practice_stream_item.date, date), eq(practice_stream_item.session_id, sessionId))
    : and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id));
}

function streamPartitionLockKey(date: string, sessionId?: string | null): string {
  return sessionId ? `stream:session:${sessionId}` : `stream:compose:${date}`;
}

async function lockDailyStreamPartition(db: DbLike, date: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${streamPartitionLockKey(date)}))`);
}

/** Rows inserted by this call plus the refs that were actually newly inserted. */
export interface MaterializeResult {
  /** Number of rows inserted by this call (= freshRefs.size). */
  added: number;
  /**
   * Refs that did not exist in the stream before this call. Only these should get a new
   * π_i observation: surviving rows were already observed when first materialized, even
   * though collectComposerInputs samples them again.
   */
  freshRefs: Set<string>;
}

/**
 * Materialize a StreamPlan in plan order.
 *
 * Positions: refs in the plan get plan index + 1; surviving rows outside the plan are
 * appended after the plan in their existing order. All rows are renumbered so
 * ORDER BY position always yields the plan order, making the due subsequence equal to
 * due_at ASC.
 *
 * `(date, position)` must stay NON-UNIQUE: renumbering temporarily gives two rows the
 * same position. Adding a unique index would fail mid-loop with 23505; free the slots
 * before assigning them first.
 */
export async function materializeStream(
  db: DbLike,
  plan: StreamPlan,
  addedBy: StreamItemRow['added_by'],
): Promise<MaterializeResult> {
  // 即便 plan 为空，也可能有 plan 外存活行需要 renumber（recompose 删 pending 后）；
  // 但若当日全空且 plan 空，无事可做。
  const existing = await db
    .select({
      id: practice_stream_item.id,
      ref_id: practice_stream_item.ref_id,
      position: practice_stream_item.position,
    })
    .from(practice_stream_item)
    .where(streamPartitionPredicate(plan.date));

  if (plan.diagnostics?.length) {
    console.warn('[practice-stream] L3 learning-mix degradation', {
      date: plan.date,
      diagnostics: plan.diagnostics,
    });
  }
  const existingByRef = new Map(existing.map((r) => [r.ref_id, r]));

  if (plan.items.length === 0 && existing.length === 0) {
    return { added: 0, freshRefs: new Set() };
  }

  const planRefSet = new Set(plan.items.map((it) => it.ref_id));
  // plan 外的存活行（已不在今日 plan）——按现 position 保序，追加在 plan 段之后。
  const survivorsOutsidePlan = existing
    .filter((r) => !planRefSet.has(r.ref_id))
    .sort((a, b) => a.position - b.position);

  const now = new Date();
  const freshRefs = new Set<string>();

  // 1) 新插入 plan 内此前不存在的 ref（position = plan index + 1）。
  const fresh = plan.items
    .map((it, i) => ({ it, pos: i + 1 }))
    .filter(({ it }) => !existingByRef.has(it.ref_id));
  if (fresh.length > 0) {
    await db
      .insert(practice_stream_item)
      .values(
        fresh.map(({ it, pos }) => {
          freshRefs.add(it.ref_id);
          return {
            id: newId(),
            date: plan.date,
            position: pos,
            item_kind: it.item_kind,
            ref_id: it.ref_id,
            source: it.source,
            status: 'pending' as const,
            reasoning: it.reasoning,
            added_by: addedBy,
            // 选题信号快照，缺省 {}（零行为变更）。
            signals: it.signals ?? {},
            created_at: now,
            updated_at: now,
          };
        }),
      )
      // 并发兜底：若另一路已抢先插了同 ref，本行不插，且从 freshRefs 里剔除（它不是
      // 「我们插的」）。advisory-lock 单飞后此路径正常不触发，但保留双保险。
      .onConflictDoNothing();
    // onConflictDoNothing 不回报哪几行被吞——advisory 锁下不会发生冲突，这里乐观地
    // 认为 fresh 都插成了。极端并发下 freshRefs 可能含一条没真插的 ref，会让调用方多记
    // 一条 telemetry-only 观测（无害，非承重写）；single-flight 锁已消除此竞态。
  }

  // 2) renumber 存活行到目标 position（plan 内取 plan 位，plan 外追加在 plan 段之后）。
  // 新插入的 fresh 行已落在正确 position，不在此重排。
  const planLen = plan.items.length;
  const planPosByRef = new Map(plan.items.map((it, i) => [it.ref_id, i + 1]));
  for (const r of existing) {
    const target = planRefSet.has(r.ref_id)
      ? (planPosByRef.get(r.ref_id) as number)
      : planLen + 1 + survivorsOutsidePlan.findIndex((s) => s.ref_id === r.ref_id);
    if (target !== r.position) {
      await db
        .update(practice_stream_item)
        .set({ position: target, updated_at: now })
        .where(eq(practice_stream_item.id, r.id));
    }
  }

  return { added: freshRefs.size, freshRefs };
}

/**
 * Resolve the selection policy: env `SELECTION_POLICY=legacy` forces the deterministic
 * composer; unknown values fall back to the default rather than failing the stream.
 */
export function resolveSelectionPolicy(): SelectionPolicyConfig {
  // DB > env > code-default('softmax_mfi')；未识别 env 值落默认（不
  // fail-fast——选题不能因配置 typo 挂）。
  const raw = getConfig('SELECTION_POLICY');
  if (raw === 'legacy') return { policy: 'legacy' };
  if (raw === 'softmax_mfi') return { policy: 'softmax_mfi' };
  return { policy: DEFAULT_SELECTION_POLICY };
}

/**
 * Materialized rows plus observations that must be written after the short transaction
 * commits, so telemetry failure can never roll back the stream.
 */
interface ComposeOutcome {
  /** Added rows; matches materializeStream's contract. */
  added: number;
  /** Written after commit; empty on the legacy path. */
  observations: SelectionObservationInput[];
}

interface PreparedCompose {
  plan: StreamPlan;
  sampledInclusion: Map<string, number>;
  signalByRef: Map<string, CollectedSignal>;
}

/**
 * Prepare an immutable plan. Mem0 and runTask happen before the short materialization
 * transaction, so preparation never reads a stale stream snapshot.
 */
async function prepareCompose(
  db: Db,
  date: string,
  policy: SelectionPolicyConfig,
  deps: ComposeSoftmaxDeps = {},
  capacity?: ComposerInputs['capacity'],
): Promise<PreparedCompose> {
  // Preparation deliberately does not read practice_stream_item. Candidate collection, the
  // optional Mem0 prior, and runTask therefore cannot capture a stale stream snapshot. Callers
  // probe and finalize under streamPartitionLockKey, the ordering boundary also used by
  // reRankAfterAnswer and intervention materialization.
  const inputs = await collectComposerInputs(db, date);
  // Injected for tests; production uses composeSoftmaxStream's defaults. Tightening max
  // makes targetCount smaller than the candidate count, so π_i is genuinely below 1.
  if (capacity) inputs.capacity = capacity;

  if (policy.policy === 'legacy') {
    return {
      plan: composeDailyStream(inputs),
      sampledInclusion: new Map(),
      signalByRef: new Map(),
    };
  }

  // softmax_mfi never throws; it has two fallback levels.
  const result: ComposeSoftmaxResult = await composeSoftmaxStream(db, inputs, policy, deps);
  return {
    plan: result.plan,
    sampledInclusion: result.sampledInclusion,
    signalByRef: result.signalByRef,
  };
}

async function materializePreparedCollect(
  db: DbLike,
  date: string,
  prepared: PreparedCompose,
  addedBy: StreamItemRow['added_by'],
): Promise<ComposeOutcome> {
  const { added, freshRefs } = await materializeStream(db, prepared.plan, addedBy);

  // Collect π_i only for rows newly inserted this round. Surviving rows were sampled
  // again by collectComposerInputs but were already observed when first materialized;
  // observing them again would pollute the π_i asset. Re-read rows to get their ids.
  const observations: SelectionObservationInput[] = [];
  if (prepared.sampledInclusion.size > 0 && freshRefs.size > 0) {
    const rows = await db
      .select({ id: practice_stream_item.id, ref_id: practice_stream_item.ref_id })
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date));
    const idByRef = new Map(rows.map((r) => [r.ref_id, r.id]));
    for (const [refId, pi] of prepared.sampledInclusion) {
      // Surviving rows were observed when first materialized.
      if (!freshRefs.has(refId)) continue;
      const signal = prepared.signalByRef.get(refId);
      observations.push({
        date,
        streamItemId: idByRef.get(refId),
        refKind: 'question',
        refId,
        policy: 'softmax_mfi',
        selected: true,
        inclusionProbability: pi,
        signals: toSignalsJson(signal),
      });
    }
  }

  return { added, observations };
}

/**
 * Write selection observations after the short transaction commits, using the top-level
 * `db` and independent try/catch per row. Telemetry is best-effort: a failure is logged
 * and must never roll back or fail the stream.
 */
async function writeObservationsBestEffort(
  db: Db,
  observations: SelectionObservationInput[],
): Promise<void> {
  for (const obs of observations) {
    try {
      await recordSelectionObservation(db, obs);
    } catch (err) {
      console.error('[stream-store] recordSelectionObservation failed (post-commit, best-effort)', {
        refId: obs.refId,
        pi: obs.inclusionProbability,
        err,
      });
    }
  }
}

/**
 * Single-flight compose. A reserved connection holds the paid-work advisory lock while
 * prepare/Mem0/runTask run outside a transaction; a short probe under the
 * `stream:compose:<date>` writer lock returns early when another request already composed.
 * The final short transaction takes the same writer key and materializes. This keeps
 * expensive work serialized without blocking reRank/intervention writers.
 *
 * Observations are collected in the transaction but written after commit (see
 * writeObservationsBestEffort), so telemetry cannot abort the stream.
 *
 * @returns Added rows; 0 when this call lost the race and no-ops.
 */
async function singleFlightCompose(
  db: Db,
  date: string,
  policy: SelectionPolicyConfig,
  deps: ComposeSoftmaxDeps,
  capacity?: ComposerInputs['capacity'],
  // 物化来源标注。lazy-compose / recompose 传 'composer_live'（缺省）；
  // 夜间预产 job 经 composeNightly 传 'composer_nightly'。双重检查 + 单飞锁不变，
  // 只 addedBy 透传到 materializePreparedCollect。
  addedBy: StreamItemRow['added_by'] = 'composer_live',
): Promise<number> {
  const lockDeadlineAt =
    deps.providerInvocation?.deadlineAt ?? new Date(Date.now() + DEFAULT_COMPOSE_LOCK_WAIT_MS);
  const { added, observations } = await withinComposePaidWorkLock(
    db,
    date,
    lockDeadlineAt,
    async (lockedDb) => {
      const count = await lockedDb.transaction(async (tx) => {
        await lockDailyStreamPartition(tx, date);
        const [result] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(practice_stream_item)
          .where(streamPartitionPredicate(date));
        return result.count;
      });
      if (count > 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

      const lockedDeps = deps.providerInvocation
        ? {
            ...deps,
            providerInvocation: { ...deps.providerInvocation, db: lockedDb },
          }
        : deps;
      const prepared = await prepareCompose(lockedDb, date, policy, lockedDeps, capacity);
      return lockedDb.transaction(async (tx) => {
        await lockDailyStreamPartition(tx, date);
        const [{ finalCount }] = await tx
          .select({ finalCount: sql<number>`count(*)::int` })
          .from(practice_stream_item)
          .where(streamPartitionPredicate(date));
        if (finalCount > 0) return { added: 0, observations: [] } satisfies ComposeOutcome;
        return materializePreparedCollect(tx, date, prepared, addedBy);
      });
    },
  );

  // 事务已提交（流已稳）——锁外 best-effort 写观测；失败只丢遥测，绝不回滚流。
  await writeObservationsBestEffort(db, observations);
  return added;
}

/**
 * Nightly pre-compose entry. Shares singleFlightCompose's lock and double-check with the
 * user's first read; the only difference is `added_by='composer_nightly'`. Already
 * materialized streams are left untouched, so repeated runs and lazy first reads no-op.
 *
 * @returns Added rows; 0 when the stream already exists.
 */
export async function composeNightly(
  db: Db,
  date: string,
  opts: {
    policy?: SelectionPolicyConfig;
    composeDeps?: ComposeSoftmaxDeps;
    /** 容量注入（DI，仅测试用）。production 省略。 */
    capacity?: ComposerInputs['capacity'];
  } = {},
): Promise<number> {
  return singleFlightCompose(
    db,
    date,
    opts.policy ?? resolveSelectionPolicy(),
    opts.composeDeps ?? {},
    opts.capacity,
    'composer_nightly',
  );
}

const SCOPED_QUESTION_LIMIT = 5;

function scopedSessionDateBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

interface KnowledgeScopedSessionRef {
  id: string;
  status: string;
}

async function findKnowledgeScopedSession(
  db: DbLike,
  date: string,
  knowledgeId: string,
): Promise<KnowledgeScopedSessionRef | null> {
  const { start, end } = scopedSessionDateBounds(date);
  const [session] = await db
    .select({ id: learning_session.id, status: learning_session.status })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'review'),
        inArray(learning_session.status, ['started', 'paused', 'completed']),
        isNull(learning_session.artifact_id),
        gte(learning_session.created_at, start),
        lt(learning_session.created_at, end),
        sql`${learning_session.scope_knowledge_ids} = ${JSON.stringify([knowledgeId])}::jsonb`,
      ),
    )
    .orderBy(desc(learning_session.created_at), desc(learning_session.id))
    .limit(1);
  return session ?? null;
}

async function materializeKnowledgeScopedSession(
  db: Db,
  date: string,
  knowledgeId: string,
  knowledgeLabel: string,
): Promise<{ sessionId: string; rows: StreamItemRow[] }> {
  return db.transaction(async (tx) => {
    // Scope identity lock prevents two first opens from creating duplicate sessions. Once the
    // session is known, also take the physical partition lock shared with answer-time rerank so
    // materialization and rerank can never assign rows in the same partition concurrently.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:scope:${date}:${knowledgeId}`}))`,
    );

    let session = await findKnowledgeScopedSession(tx, date, knowledgeId);
    if (!session) {
      const created = await Review.startReviewSession(tx, {
        scopeKnowledgeIds: [knowledgeId],
      });
      session = { id: created.sessionId, status: 'started' };
    }
    const sessionId = session.id;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${streamPartitionLockKey(date, sessionId)}))`,
    );

    const existing = await tx
      .select()
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date, sessionId))
      .orderBy(asc(practice_stream_item.position));
    const eligibleExisting = (await filterProspectiveStreamQuestions(tx, existing)).rows;
    if (session.status === 'started' && eligibleExisting.length < SCOPED_QUESTION_LIMIT) {
      // Deterministic, local-only selection: a user-requested scope must not pay the daily LLM
      // compose cost or inherit unrelated whole-profile candidates. Pull only published questions
      // carrying this KC; keep the session snapshot stable and fill newly available vacancies.
      const candidates = await tx
        .select({ id: question.id })
        .from(question)
        .where(
          and(
            sql`${question.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`,
            notDraftPredicate(question.draft_status),
            // 契约准入门：suspended/withdrawn 组不作 scoped 填空。
            questionSuspendedPredicate(question),
          ),
        )
        .orderBy(asc(question.difficulty), desc(question.updated_at), asc(question.id));
      const admittedIds = await readAutomaticallyServableQuestionIds(
        tx,
        candidates.map((row) => row.id),
      );
      const existingRefs = new Set(existing.map((row) => row.ref_id));
      const available = candidates
        .filter((candidate) => admittedIds.has(candidate.id) && !existingRefs.has(candidate.id))
        .slice(0, SCOPED_QUESTION_LIMIT - eligibleExisting.length);
      if (available.length > 0) {
        const now = new Date();
        const startPosition = existing.reduce((max, row) => Math.max(max, row.position), 0) + 1;
        await tx
          .insert(practice_stream_item)
          .values(
            available.map((candidate, index) => ({
              id: newId(),
              date,
              session_id: sessionId,
              position: startPosition + index,
              item_kind: 'question' as const,
              ref_id: candidate.id,
              source: 'on_demand' as const,
              status: 'pending' as const,
              reasoning: `你点了「${knowledgeLabel}」专项——这道题只来自该知识点的现有题库。`,
              added_by: 'user' as const,
              signals: { scopeKind: 'knowledge', scopeId: knowledgeId },
              created_at: now,
              updated_at: now,
            })),
          )
          .onConflictDoNothing();
      }
    }

    const rows = await tx
      .select()
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date, sessionId))
      .orderBy(asc(practice_stream_item.position));
    return { sessionId, rows };
  });
}

async function getKnowledgeScopedStream(
  db: Db,
  date: string,
  knowledgeId: string,
  materialize: boolean,
): Promise<StreamView> {
  const [knowledgeRow] = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(and(eq(knowledge.id, knowledgeId), isNull(knowledge.archived_at)))
    .limit(1);
  if (!knowledgeRow) {
    throw new ApiError('not_found', `knowledge ${knowledgeId} not found`, 404);
  }

  let sessionId: string | null;
  let rows: StreamItemRow[];
  if (materialize) {
    ({ sessionId, rows } = await materializeKnowledgeScopedSession(
      db,
      date,
      knowledgeId,
      knowledgeRow.name,
    ));
  } else {
    const session = await findKnowledgeScopedSession(db, date, knowledgeId);
    sessionId = session?.id ?? null;
    rows = sessionId
      ? await db
          .select()
          .from(practice_stream_item)
          .where(streamPartitionPredicate(date, sessionId))
          .orderBy(asc(practice_stream_item.position))
      : [];
  }

  const [dailyBudget, questionPace] = await Promise.all([
    resolveDailyPracticeBudget(db),
    readQuestionPace(db),
  ]);
  const budget = {
    pace: dailyBudget.pace,
    minutes: Math.min(
      dailyBudget.minutes,
      SCOPED_QUESTION_LIMIT * estimateStreamItemMinutes('question', questionPace.minutes),
    ),
  };
  const scope: StreamScope = {
    kind: 'knowledge',
    id: knowledgeId,
    label: knowledgeRow.name,
    session_id: sessionId,
  };
  rows = (await filterProspectiveStreamQuestions(db, rows)).rows;
  return buildStreamView({
    db,
    date,
    rows,
    budget,
    scope,
    questionMinutes: questionPace.minutes,
    openingLine:
      rows.length === 0
        ? `「${knowledgeRow.name}」暂时没有可练的已发布题目。`
        : `这里仅显示「${knowledgeRow.name}」相关的题目——按顺序练即可。`,
  });
}

async function trimStoredPendingItemsToBudget(
  db: Db,
  date: string,
  budgetMinutes: number,
  questionMinutes: number,
): Promise<StreamItemRow[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${date}`}))`);
    const current = await tx
      .select()
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date))
      .orderBy(asc(practice_stream_item.position));

    const { rows: eligible, recoveryRowIds } = await filterProspectiveStreamQuestions(tx, current);
    // Recovery rows (unsupported pinned contract + accepted submission) are not
    // prospective work: they stay visible as the settlement/recovery entry point
    // but sit outside the budget economy entirely — never a trimmable tail, and
    // never consuming the minutes that decide other rows' fate.
    const frozen = eligible.filter(
      (row) => row.status !== 'pending' && !recoveryRowIds.has(row.id),
    );
    const frozenMinutes = frozen.reduce(
      (sum, row) => sum + estimateStreamItemMinutes(row.item_kind, questionMinutes),
      0,
    );
    const pending = eligible.filter(
      (row) => row.status === 'pending' && !recoveryRowIds.has(row.id),
    );
    // An intervention row is the learner-visible delivery of approved material,
    // not an ordinary recommendation tail. Never trim it merely because it was
    // appended after the day's budget was composed; instead budget the remaining
    // pending rows around this protected delivery.
    const protectedPending = pending.filter((row) => row.source === 'intervention');
    const budgetablePending = pending.filter((row) => row.source !== 'intervention');
    const protectedMinutes = protectedPending.reduce(
      (sum, row) => sum + estimateStreamItemMinutes(row.item_kind, questionMinutes),
      0,
    );
    const remaining = Math.max(0, budgetMinutes - frozenMinutes - protectedMinutes);
    const keptBudgetable =
      remaining === 0
        ? []
        : fitStreamToTimeBudget(budgetablePending, remaining, questionMinutes).kept;
    const keptPending = [...protectedPending, ...keptBudgetable];
    const keptIds = new Set(keptPending.map((row) => row.id));
    const deleteIds = pending.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
    if (deleteIds.length > 0) {
      await tx.delete(practice_stream_item).where(inArray(practice_stream_item.id, deleteIds));
    }

    return tx
      .select()
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date))
      .orderBy(asc(practice_stream_item.position));
  });
}

/**
 * 读当日流；为空且 composeIfEmpty 时 lazy compose（首次打开练习面的默认路径）。
 *
 * 选题路径由 `opts.policy`（缺省 `resolveSelectionPolicy`，读 env / 默认 softmax_mfi）
 * 裁定：legacy 走确定性 composeDailyStream；softmax_mfi 走档2 LLM-strong 路径（含两级
 * fallback + π_i 持久化）。`opts.composeDeps` 仅 DI（测试 mock runTask/rng），production 省略。
 */
export async function getStream(
  db: Db,
  date: string,
  opts: {
    composeIfEmpty?: boolean;
    policy?: SelectionPolicyConfig;
    composeDeps?: ComposeSoftmaxDeps;
    /** 容量注入（DI，仅测试用——收紧 max 测 π_i<1 / capacityGuard slice）。production 省略。 */
    capacity?: ComposerInputs['capacity'];
    /** 收敛修复前已物化的超预算 pending 尾；today 读路径随 composeIfEmpty 自动启用。 */
    enforceBudget?: boolean;
    /**refill DI（测试注 fake dispatch 捕获、不打真 pg-boss）。production 省略 →
     * refillActiveLearningPools 走默认 demandToSupplyTarget + dispatchSupplyTarget。 */
    refillDeps?: RefillDeps;
    /** server-resolved independent on-demand review session for this KC. */
    knowledgeId?: string;
    /** Materialize a scoped session/items. Historical scoped reads remain read-only. */
    materializeScoped?: boolean;
  } = {},
): Promise<StreamView> {
  if (opts.knowledgeId) {
    return getKnowledgeScopedStream(db, date, opts.knowledgeId, opts.materializeScoped ?? false);
  }

  let rows = await db
    .select()
    .from(practice_stream_item)
    .where(streamPartitionPredicate(date))
    .orderBy(asc(practice_stream_item.position));

  if (rows.length === 0 && opts.composeIfEmpty) {
    // single-flight（advisory 锁 + 双重检查）——并发 lazy-compose 不双发 LLM。
    await singleFlightCompose(
      db,
      date,
      opts.policy ?? resolveSelectionPolicy(),
      opts.composeDeps ?? {},
      opts.capacity,
    );

    // 取题瞬间 refill（compose 事务**提交后**、top-level `db`、best-effort）。检查活跃
    // 学习 KC 的活跃池，见底（< REFILL_POOL_THRESHOLD）则复用既有 dispatcher 补题。**flag-off
    // （QUESTION_SUPPLY_REFILL_ENABLED 默认 false）→ refillActiveLearningPools 入口即短路返 []
    // （零 DB 零 dispatch）→ getStream 行为 byte-identical 现状**。这是「每用户每天首次打开练习
    // 流一次」的 on-demand 补充（非 per-question / 非每次读），不在 day-one 关键路径。refill 失败
    // 绝不破坏取题（try/catch best-effort，mirror writeObservationsBestEffort 纪律）。
    try {
      await refillActiveLearningPools(db, opts.refillDeps);
    } catch (err) {
      console.error('[stream-store] refillActiveLearningPools failed (post-compose, best-effort)', {
        date,
        err,
      });
    }

    rows = await db
      .select()
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date))
      .orderBy(asc(practice_stream_item.position));
  }

  const [budget, questionPace] = await Promise.all([
    resolveDailyPracticeBudget(db),
    readQuestionPace(db),
  ]);
  const gated = await filterProspectiveStreamQuestions(db, rows);
  rows = gated.rows;
  // Recovery rows are visible but not prospective: their minutes must neither
  // trigger the trim nor decide other rows' fate (same carve-out as the trim).
  const storedMinutes = rows
    .filter((row) => !gated.recoveryRowIds.has(row.id))
    .reduce((sum, row) => sum + estimateStreamItemMinutes(row.item_kind, questionPace.minutes), 0);
  if ((opts.enforceBudget ?? opts.composeIfEmpty ?? false) && storedMinutes > budget.minutes) {
    rows = await trimStoredPendingItemsToBudget(db, date, budget.minutes, questionPace.minutes);
  }

  rows = (await filterProspectiveStreamQuestions(db, rows)).rows;
  return buildStreamView({
    db,
    date,
    rows,
    budget,
    questionMinutes: questionPace.minutes,
    scope: null,
    // Templated opening; composer_nightly may replace it with AI text.
    openingLine:
      rows.length === 0
        ? '今天流里还没有东西——录几道题，或向我点播一份卷。'
        : '今天的流我排好了——从上往下做，卡住随时叫我。',
  });
}

const LEGAL_TRANSITIONS: Record<StreamItemStatus, StreamItemStatus[]> = {
  pending: ['in_progress', 'done', 'skipped'],
  in_progress: ['done', 'pending', 'skipped'],
  // 捡回（设计稿「跳过 · 流尾可回头」）
  skipped: ['pending', 'in_progress'],
  done: [],
};

async function completeScopedSessionIfDone(db: Db, row: StreamItemRow): Promise<void> {
  if (!row.session_id || row.status !== 'done') return;
  try {
    const [{ remaining }] = await db
      .select({ remaining: sql<number>`count(*)::int` })
      .from(practice_stream_item)
      .where(
        and(
          eq(practice_stream_item.session_id, row.session_id),
          inArray(practice_stream_item.status, ['pending', 'in_progress', 'skipped']),
        ),
      );
    if (remaining === 0) {
      await Review.transitionReviewSession(db, row.session_id, 'completed');
    }
  } catch (err) {
    // The stream-item transition is already committed. Session-envelope closeout is important
    // observability, but must not turn a confirmed answer into a false PATCH failure.
    console.error('[stream-store] scoped review session completion failed (best-effort)', {
      sessionId: row.session_id,
      streamItemId: row.id,
      err,
    });
  }
}

/**
 * Advance an item's schedule row. Answer facts are written by the submit route; this
 * only moves the daily-stream row.
 *
 * After a question item reaches `done`, rerank pending non-due items touching its KCs with
 * the updated θ̂. Rerank is best-effort and synchronous: it uses only the statistical
 * sampler (no LLM) and is wrapped in try/catch so a failure cannot roll back the committed
 * transition or turn the PATCH into a 500. It is skipped under the legacy policy, whose
 * deterministic compose must not be perturbed.
 */
export async function advanceStreamItem(
  db: Db,
  id: string,
  next: StreamItemStatus,
  // Injected rng for deterministic Poisson sampling in tests.
  rerankDeps: { rng?: () => number } = {},
): Promise<StreamItemRow | null> {
  const [row] = await db
    .select()
    .from(practice_stream_item)
    .where(eq(practice_stream_item.id, id))
    .limit(1);
  if (!row) return null;
  if (!LEGAL_TRANSITIONS[row.status].includes(next)) {
    throw new ApiError('conflict', `illegal stream transition ${row.status} -> ${next}`, 409);
  }
  if (row.source === 'intervention') {
    if (next === 'skipped') {
      throw new ApiError(
        'conflict',
        'intervention diagnostics cannot be skipped before completion',
        409,
      );
    }
    if (next === 'done') {
      const [attempt] = await db
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.action, 'review'),
            eq(event.subject_kind, 'question'),
            eq(event.subject_id, row.ref_id),
            row.session_id === null
              ? isNull(event.session_id)
              : eq(event.session_id, row.session_id),
            gte(event.created_at, row.created_at),
            sql`${event.payload} ->> 'stream_item_id' = ${row.id}`,
          ),
        )
        .limit(1);
      if (!attempt) {
        throw new ApiError(
          'conflict',
          'intervention diagnostics can be completed only after a recorded attempt',
          409,
        );
      }
    }
  }
  const [updated] = await db
    .update(practice_stream_item)
    .set({ status: next, updated_at: new Date() })
    .where(eq(practice_stream_item.id, id))
    .returning();
  if (!updated) return null;

  await completeScopedSessionIfDone(db, updated);

  // Rerank only completed question items, and only under the softmax policy: the legacy
  // path must stay deterministic, so its stream must not be randomly reshuffled.
  const policyForRerank = resolveSelectionPolicy().policy;
  if (
    policyForRerank === 'softmax_mfi' &&
    updated.status === 'done' &&
    updated.item_kind === 'question'
  ) {
    try {
      await reRankAfterAnswer(db, {
        date: updated.date,
        sessionId: updated.session_id,
        answeredQuestionId: updated.ref_id,
        rng: rerankDeps.rng,
      });
    } catch (err) {
      // Rerank is a convenience layer; failure must not undo the committed transition.
      console.error('[stream-store] reRankAfterAnswer failed (post-commit, best-effort)', {
        streamItemId: updated.id,
        refId: updated.ref_id,
        err,
      });
    }
  }
  return updated;
}

/**
 * Manual recompose: keep done/in_progress/skipped rows, delete pending rows, then compose
 * again from current signals. Uses the same paid-work lock as lazy compose; captures
 * pending ids under the writer lock, prepares outside the transaction, and deletes only
 * rows that are still pending, so interventions arriving during prepare survive.
 * Observations are written after commit, best-effort.
 */
export async function recomposeStream(
  db: Db,
  date: string,
  opts: {
    policy?: SelectionPolicyConfig;
    composeDeps?: ComposeSoftmaxDeps;
    /** 容量注入（DI，仅测试用）。production 省略。 */
    capacity?: ComposerInputs['capacity'];
  } = {},
): Promise<number> {
  const deps = opts.composeDeps ?? {};
  const lockDeadlineAt =
    deps.providerInvocation?.deadlineAt ?? new Date(Date.now() + DEFAULT_COMPOSE_LOCK_WAIT_MS);
  const { added, observations } = await withinComposePaidWorkLock(
    db,
    date,
    lockDeadlineAt,
    async (lockedDb) => {
      const pendingIdsAtPrepare = await lockedDb.transaction(async (tx) => {
        await lockDailyStreamPartition(tx, date);
        const rows = await tx
          .select({ id: practice_stream_item.id })
          .from(practice_stream_item)
          .where(and(streamPartitionPredicate(date), eq(practice_stream_item.status, 'pending')));
        return rows.map((row) => row.id);
      });
      const lockedDeps = deps.providerInvocation
        ? {
            ...deps,
            providerInvocation: { ...deps.providerInvocation, db: lockedDb },
          }
        : deps;
      const prepared = await prepareCompose(
        lockedDb,
        date,
        opts.policy ?? resolveSelectionPolicy(),
        lockedDeps,
        opts.capacity,
      );
      return lockedDb.transaction(async (tx) => {
        await lockDailyStreamPartition(tx, date);
        if (pendingIdsAtPrepare.length > 0) {
          await tx
            .delete(practice_stream_item)
            .where(
              and(
                streamPartitionPredicate(date),
                eq(practice_stream_item.status, 'pending'),
                inArray(practice_stream_item.id, pendingIdsAtPrepare),
              ),
            );
        }
        return materializePreparedCollect(tx, date, prepared, 'composer_live');
      });
    },
  );

  // 事务已提交（流已稳）——锁外 best-effort 写观测。
  await writeObservationsBestEffort(db, observations);
  return added;
}

// ═══════════════════════════════════════════════════════════════════════════
// Post-answer incremental rerank (softmax_mfi only).
// ═══════════════════════════════════════════════════════════════════════════
// Answering moves θ̂ for the question's knowledge_ids, which changes the MFI weight
// p(1−p), p=σ(θ̂−b), of pending non-due diagnostic items. Rerank those items with the
// fresh θ̂ using the statistical sampler only: no whole-stream rebuild and no LLM call
// (LLM item weights are not persisted, so recomputing mfiScore is the cheapest correct
// weight).
// Scope and shape:
// - The candidate pool is the full eligible non-due pool (same variant/new_check sources
// as compose), excluding frozen refs. targetCount is the number of replaceable pending
// slots, not the pool size, so sampling is real IPPS (π_i < 1).
// - Only items touching the answered question's KCs are reranked. Unrelated pending
// items, due rows, paper rows, recall-locked rows, and done/in_progress/skipped rows
// stay frozen: not deleted, not moved, not re-sampled.
// - A row whose snapshot is not recall-locked but whose fresh classification is recall
// stays in place (fail-closed); never drop it into a freed slot.
// - Sample sizes fluctuate. Delete only slots that will actually be refilled
// (min(new refs, replaceable slots), lowest position first) and keep the rest, so the
// stream never shrinks or leaves position holes.
// - Record π_i only for rows that really inserted (post-commit, best-effort); kept slots
// reuse their original observation.
// - Reuse the `stream:compose:<date>` advisory lock, so rerank never races compose.
// - Frozen and kept rows keep their exact positions; new items fill freed slots first,
// then append after max(position). This deliberately differs from materializeStream's
// full renumber, which recompose semantics allow.

/** 从 practice_stream_item.signals 快照读 recallLocked。 */
function rowIsRecallLocked(signals: unknown): boolean {
  return (signals as { recallLocked?: unknown } | null)?.recallLocked === true;
}

/**
 * 作答后有界增量重排（hybrid 运行时）。**永不 throw 出 compose 逻辑级别**——纯统计 sampler，
 * 无 LLM。若无受影响待做项（θ̂ 移动不触及任何待做非到期诊断项）→ no-op（不动流、不写观测）。
 *
 * @param opts.answeredQuestionId 刚推进到 done 的题——其 knowledge_ids = affectedKnowledgeIds。
 * @param opts.rng 注入 rng（测试确定化）；省略 → sampleByWeight 默认 Math.random。
 * @returns 本轮新物化（重抽样落库）的非到期项数；no-op 时 0。
 */
export async function reRankAfterAnswer(
  db: Db,
  opts: {
    date: string;
    sessionId?: string | null;
    answeredQuestionId: string;
    rng?: () => number;
  },
): Promise<number> {
  const { date, sessionId, answeredQuestionId } = opts;

  // 受影响 KC = 刚答完那题的 knowledge_ids。空 → 无 θ̂ 移动锚点 → no-op（不触发重排）。
  const [answered] = await db
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, answeredQuestionId))
    .limit(1);
  const affectedKnowledgeIds = new Set((answered?.knowledge_ids ?? []).filter(Boolean));
  if (affectedKnowledgeIds.size === 0) return 0;

  const { added, observations } = await db.transaction(async (tx) => {
    // Same key as every compose path, so rerank cannot race lazy/recompose/nightly.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${streamPartitionLockKey(date, sessionId)}))`,
    );

    const rows = await tx
      .select()
      .from(practice_stream_item)
      .where(streamPartitionPredicate(date, sessionId))
      .orderBy(asc(practice_stream_item.position));
    if (rows.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Rerank scope: pending question items from variant/new_check whose snapshot is not
    // recall-locked. Due rows, paper rows, recall-locked rows, and completed/in-progress/
    // skipped rows are frozen. Frontier items are sampled at compose time but excluded
    // here: frontier signals structural reachability, not θ̂ diagnostics, so answering must
    // not churn them. Changing either side must preserve that split.
    const allPendingNonDue = rows.filter(
      (r) =>
        r.status === 'pending' &&
        r.item_kind === 'question' &&
        (r.source === 'variant' || r.source === 'new_check') &&
        !rowIsRecallLocked(r.signals),
    );
    // 无待做非到期诊断行 → no-op（不动流、不写观测）。
    if (allPendingNonDue.length === 0)
      return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Narrow scope to rows touching the answered question's KCs. Answering KC-A must not
    // churn an unrelated KC-B slot; untouched pending rows stay frozen.
    const pendingNonDueQids = [...new Set(allPendingNonDue.map((r) => r.ref_id))];
    const pendingQRows =
      pendingNonDueQids.length === 0
        ? []
        : await tx
            .select({ id: question.id, knowledge_ids: question.knowledge_ids })
            .from(question)
            .where(inArray(question.id, pendingNonDueQids));
    const pendingKidsByQid = new Map(pendingQRows.map((q) => [q.id, q.knowledge_ids ?? []]));
    const pendingNonDue = allPendingNonDue.filter((r) =>
      (pendingKidsByQid.get(r.ref_id) ?? []).some((k) => affectedKnowledgeIds.has(k)),
    );
    // 答完题的 KC 不触及任何待做非到期行 → 无可重排的 slot → no-op（不 churn 无关 slot）。
    if (pendingNonDue.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Candidate pool is the full eligible non-due pool from compose; due and paper rows
    // stay frozen.
    const composerInputs = await collectComposerInputs(tx, date);
    const poolRaws = [
      ...composerInputs.variantItems.map((v) => ({
        questionId: v.questionId,
        source: 'variant' as const,
        knowledgeLabel: v.knowledgeLabel,
      })),
      ...composerInputs.newCheckItems.map((n) => ({
        questionId: n.questionId,
        source: 'new_check' as const,
        knowledgeLabel: n.knowledgeLabel,
      })),
    ];

    // Everything outside the affected pending non-due scope is frozen: excluded from the
    // pool and never moved or re-sampled.
    const pendingNonDueRefs = new Set(pendingNonDue.map((r) => r.ref_id));
    const frozenRefs = new Set(
      rows.filter((r) => !pendingNonDueRefs.has(r.ref_id)).map((r) => r.ref_id),
    );

    // Exclude frozen refs and dedup in memory; the unique index is the backstop.
    const seenPool = new Set<string>();
    const eligibleRaws = poolRaws.filter(
      (r) =>
        !frozenRefs.has(r.questionId) && !seenPool.has(r.questionId) && seenPool.add(r.questionId),
    );
    if (eligibleRaws.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    const candidateInputs = await readStreamSelectionCandidates(
      tx,
      eligibleRaws.map((r) => ({ questionId: r.questionId, role: r.source })),
    );

    // Rerank only when the eligible pool touches an affected KC.
    const poolTouchesAffected = candidateInputs.some((candidate) =>
      (candidate.knowledgeIds ?? []).some((k) => affectedKnowledgeIds.has(k)),
    );
    if (!poolTouchesAffected) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Fresh θ̂: collectCandidateSignals reads current mastery_state.
    const sourceByRef = new Map(eligibleRaws.map((r) => [r.questionId, r.source]));
    const labelByRef = new Map(eligibleRaws.map((r) => [r.questionId, r.knowledgeLabel]));
    const signals: CollectedSignal[] = await collectCandidateSignals(tx, candidateInputs);
    const signalByRef = new Map(signals.map((s) => [s.refId, s]));

    // A row that freshly classifies as recall stays in place (fail-closed); never drop it
    // into a freed slot.
    const freshRecallRefs = new Set(
      signals.filter((s) => s.recallLocked === true).map((s) => s.refId),
    );
    // Candidates that are not recall-locked.
    const samplable = signals.filter((s) => s.recallLocked !== true);

    // Pending non-due rows that may be swapped out. Actual deletion is bounded by how many
    // new refs really insert.
    const replaceableRows = pendingNonDue
      .filter((r) => !freshRecallRefs.has(r.ref_id))
      .sort((a, b) => a.position - b.position);
    if (replaceableRows.length === 0)
      return { added: 0, observations: [] } satisfies ComposeOutcome;
    const replaceableRefs = new Set(replaceableRows.map((r) => r.ref_id));

    // Refs already in the stream and not being deleted must not be reinserted. Compute the
    // base set before deciding deletions; kept refs are added back below.
    const baseKeptRefs = new Set(
      rows.filter((r) => !replaceableRefs.has(r.ref_id)).map((r) => r.ref_id),
    );

    // Statistical sampler with fresh θ̂. targetCount is the replaceable slot count, not the
    // pool size, so sampling is real IPPS (π_i < 1).
    const weighted = statisticalWeights(samplable);
    const sampled =
      weighted.length === 0
        ? []
        : sampleByWeight(weighted, {
            temperature: DEFAULT_TEMPERATURE,
            targetCount: replaceableRows.length,
            rng: opts.rng,
          });

    // Sample sizes fluctuate around targetCount. Delete only slots that will actually be
    // refilled: min(new refs, replaceable slots), lowest position first. Kept rows stay put,
    // so the stream never shrinks or leaves holes. π_i stays the true inclusion probability
    // (same targetCount, no top-up), and kept slots reuse their original observation.
    const newRefPicks: string[] = [];
    const seenNewRef = new Set<string>();
    for (const s of sampled) {
      if (baseKeptRefs.has(s.refId)) continue; // 已在流里且不删 → 不是「换进的新项」。
      if (seenNewRef.has(s.refId)) continue; // 去重（同 ref 只占一个 slot）。
      seenNewRef.add(s.refId);
      newRefPicks.push(s.refId);
    }
    // Never delete more slots than can be refilled.
    const deleteCount = Math.min(newRefPicks.length, replaceableRows.length);
    const rowsToDelete = replaceableRows.slice(0, deleteCount); // 最低 position 的 deleteCount 个。
    const deletedRefs = new Set(rowsToDelete.map((r) => r.ref_id));
    const vacatedPositions = rowsToDelete.map((r) => r.position).sort((a, b) => a - b);

    // Rows that survive this rerank cannot be reinserted.
    const keptRefs = new Set(rows.filter((r) => !deletedRefs.has(r.ref_id)).map((r) => r.ref_id));

    // Nothing to delete means nothing to insert.
    if (rowsToDelete.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // Delete only slots that will be refilled; frozen and kept rows stay untouched.
    await tx.delete(practice_stream_item).where(
      and(
        streamPartitionPredicate(date, sessionId),
        inArray(
          practice_stream_item.id,
          rowsToDelete.map((r) => r.id),
        ),
      ),
    );

    // Fill vacated positions first, then append after max(position). Skip refs kept in the
    // stream, and record π_i only for rows that actually insert.
    const maxPosition = rows.reduce((m, r) => Math.max(m, r.position), 0);
    let tailPos = maxPosition + 1;
    let slot = 0;
    const now = new Date();
    const observations: SelectionObservationInput[] = [];
    let added = 0;
    for (const s of sampled) {
      if (keptRefs.has(s.refId)) continue;
      const pos = slot < vacatedPositions.length ? vacatedPositions[slot] : tailPos++;
      slot++;
      const signal = signalByRef.get(s.refId);
      const presentation = presentNonDueQuestion(sourceByRef.get(s.refId), labelByRef.get(s.refId));
      const newRowId = newId();
      const inserted = await tx
        .insert(practice_stream_item)
        .values({
          id: newRowId,
          date,
          session_id: sessionId ?? null,
          position: pos,
          item_kind: 'question' as const,
          ref_id: s.refId,
          source: presentation.source,
          status: 'pending' as const,
          // Rerank changes order only; keep the original reasoning template.
          reasoning: presentation.reasoning,
          added_by: 'composer_live' as const,
          signals: toSignalsJson(signal),
          created_at: now,
          updated_at: now,
        })
        // Swallowed inserts report nothing, so they are neither counted nor observed.
        .onConflictDoNothing()
        .returning({ id: practice_stream_item.id });
      // A swallowed row did not occupy the slot; let the next pick use it.
      if (inserted.length === 0) {
        slot--; // 没真占用空位，让回 slot 游标（下一个抽中项可填这个 position）。
        continue;
      }
      added++;
      observations.push({
        date,
        streamItemId: newRowId,
        refKind: 'question',
        refId: s.refId,
        policy: 'softmax_mfi',
        selected: true,
        inclusionProbability: s.inclusionProbability,
        signals: toSignalsJson(signal),
      });
    }

    return { added, observations };
  });

  // Best-effort observations after commit.
  await writeObservationsBestEffort(db, observations);
  return added;
}

function toSignalsJson(signal: CollectedSignal | undefined): Record<string, unknown> {
  return { ...signal };
}
