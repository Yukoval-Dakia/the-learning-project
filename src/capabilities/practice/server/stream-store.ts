// M2 (YUK-316) — 流编排器的 IO 壳：输入收集 + StreamPlan 物化 + 读取/推进。
// 纯函数核心在 stream-composer.ts；本文件只做 DB/handler 编排。
//
// 输入信号来源（P2 spec §2.1「due-list 降级为输入信号」）：
//   - dueItems：内部调用 handleReviewDue（函数调用、零网络）——FSRS 到期投影 +
//     跨学科 round-robin + goal 软偏置全部复用现行为；旧 /api/review/due 不删。
//   - variantItems：mistake_variant(status='active') 中 parent 近 7 天有 failure
//     attempt 的变体（变体轮换的「错题跟练」信号）。
//   - newCheckItems：active learning_item 的 knowledge_ids 中尚无 FSRS 状态行的
//     知识点（= 学了还没检验），各取一道未排入的题。
//   - pendingPapers：getPracticeList 的 ready 且未开始 session 的卷。
//
// opening/closing line：M2 为模板（M4 夜链 AI 化后由 composer_nightly 写入）。

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import {
  event,
  knowledge,
  learning_item,
  material_fsrs_state,
  mistake_variant,
  practice_stream_item,
  question,
} from '@/db/schema';
import { ApiError } from '@/server/http/errors';
import { and, asc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';

import { handleReviewDue } from './due-list';
import { getPracticeList } from './practice-read';
import { DEFAULT_SELECTION_POLICY, type SelectionPolicyConfig } from './selection-constants';
import { recordSelectionObservation } from './selection-observations';
import {
  type ComposeSoftmaxDeps,
  type ComposeSoftmaxResult,
  composeSoftmaxStream,
} from './softmax-selection';
import { type ComposerInputs, type StreamPlan, composeDailyStream } from './stream-composer';

export type StreamItemRow = typeof practice_stream_item.$inferSelect;
export type StreamItemStatus = StreamItemRow['status'];

/** 本模块的 DB 句柄：既可是顶层 `db`，也可是事务内 `tx`（single-flight 锁需要事务）。 */
type DbLike = Db | Tx;

const DUE_INPUT_LIMIT = 10;
const VARIANT_WINDOW_DAYS = 7;

async function knowledgeLabels(db: DbLike, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function collectComposerInputs(db: DbLike, date: string): Promise<ComposerInputs> {
  // 1. FSRS 到期投影 — 经现行 due handler（函数调用）。
  const dueRes = await handleReviewDue(
    new Request(`http://internal/api/review/due?limit=${DUE_INPUT_LIMIT}`),
  );
  const dueJson = (await dueRes.json()) as {
    rows?: Array<{ question_id: string; knowledge_ids?: string[] }>;
  };
  const dueRows = dueJson.rows ?? [];

  // 2. 错题变式 — active 变体，parent 近窗口内有 failure attempt。
  const since = new Date(Date.now() - VARIANT_WINDOW_DAYS * 24 * 3600 * 1000);
  const recentFailures = await db
    .select({ qid: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'attempt'),
        eq(event.outcome, 'failure'),
        eq(event.subject_kind, 'question'),
        gte(event.created_at, since),
      ),
    );
  const failedQids = [...new Set(recentFailures.map((r) => r.qid))];
  const variantRows =
    failedQids.length === 0
      ? []
      : await db
          .select({
            variant_question_id: mistake_variant.variant_question_id,
            parent_question_id: mistake_variant.parent_question_id,
          })
          .from(mistake_variant)
          .where(
            and(
              eq(mistake_variant.status, 'active'),
              isNotNull(mistake_variant.variant_question_id),
              inArray(mistake_variant.parent_question_id, failedQids),
            ),
          );

  // 3. 新学待检 — active 学习项的知识点里没有 FSRS 状态行的。
  const items = await db
    .select({ knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(inArray(learning_item.status, ['active', 'in_progress']));
  const candidateKids = [...new Set(items.flatMap((i) => i.knowledge_ids))];
  let newCheckPairs: Array<{ questionId: string; knowledgeId: string }> = [];
  if (candidateKids.length > 0) {
    const tracked = await db
      .select({ kid: material_fsrs_state.subject_id })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          inArray(material_fsrs_state.subject_id, candidateKids),
        ),
      );
    const trackedSet = new Set(tracked.map((r) => r.kid));
    const untracked = candidateKids.filter((k) => !trackedSet.has(k));
    if (untracked.length > 0) {
      // 每个未检验知识点取一道题（JSONB 包含查询，active 题）。
      for (const kid of untracked) {
        const [q] = await db
          .select({ id: question.id })
          .from(question)
          .where(sql`${question.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`)
          .limit(1);
        if (q) newCheckPairs.push({ questionId: q.id, knowledgeId: kid });
      }
      newCheckPairs = newCheckPairs.slice(0, 3);
    }
  }

  // 4. 当日待做卷 — ready 且未开始 session。
  const practiceList = await getPracticeList(db);
  const pendingPapers = practiceList.papers
    .filter((p) => p.generation_status === 'ready' && p.session === null)
    .map((p) => ({
      paperId: p.artifact_id,
      title: p.title,
      source:
        p.intent_source === 'ingestion_paper'
          ? ('import' as const)
          : p.intent_source === 'quiz_gen'
            ? ('on_demand' as const)
            : ('paper' as const),
    }));

  // 标签批量解析（reasoning 模板用）。
  const labelMap = await knowledgeLabels(db, [
    ...dueRows.flatMap((r) => r.knowledge_ids ?? []).slice(0, 50),
    ...newCheckPairs.map((p) => p.knowledgeId),
  ]);

  return {
    date,
    dueItems: dueRows.map((r) => ({
      questionId: r.question_id,
      knowledgeLabel: r.knowledge_ids?.length ? labelMap.get(r.knowledge_ids[0]) : undefined,
    })),
    variantItems: variantRows
      .filter((v): v is { variant_question_id: string; parent_question_id: string } =>
        Boolean(v.variant_question_id),
      )
      .map((v) => ({ questionId: v.variant_question_id, rootQuestionId: v.parent_question_id })),
    newCheckItems: newCheckPairs.map((p) => ({
      questionId: p.questionId,
      knowledgeId: p.knowledgeId,
      knowledgeLabel: labelMap.get(p.knowledgeId),
    })),
    pendingPapers,
  };
}

/** materializeStream 的结果：新增行数 + **本轮真正新插入**的 ref 集合（CLUSTER A 用）。 */
export interface MaterializeResult {
  /** 本轮 INSERT 真正落库的新行数（= freshRefs.size）。 */
  added: number;
  /**
   * 本轮**新插入**的 ref 集合（DB 里此前不存在的）。调用方据此只对新落的项记 π_i：
   * 已物化（recompose 中存活）的 ref 保留其原始观测，不重复写（CLUSTER A 修复——
   * recompose 时存活的 done/in_progress 行会被 collectComposerInputs 重新收集 → 再次进
   * sampledInclusion，但它们并非「本轮新发生的选题」，不该再记一条 π_i 观测）。
   */
  freshRefs: Set<string>;
}

/**
 * 物化 StreamPlan，position **取 plan 的意图序**（CLUSTER B 修复）——不再「append-after-max」。
 *
 * 位置模型（保证 getStream 的 ORDER BY position 永远吐 plan 序，与完成/recompose 历史无关）：
 *   1. plan.items 已是 due-L1 序（due_at ASC）→ 非到期 → 卷的最终意图序。
 *   2. plan 内的 ref（无论新插还是存活）→ position = 在 plan 里的 index+1。
 *   3. plan **外**的存活行（已不在今日 plan，如已不到期的旧到期项 / 已结束的卷）→
 *      追加在 plan.items.length 之后，按其当前 position 保序，避免与 plan 段冲突。
 *   4. 全量 UPDATE 当日所有行的 position（存活行改位、保 status），新行 INSERT 到目标位。
 * 这样 due 子序列在 DB 里恒等于 L1 序——recompose 删-再加早到期项也不会被排到存活晚到期项之后。
 *
 * **NO 重复 position**：最终每行一个唯一 position（1..M 连续，M = plan + plan外存活）。
 * date+ref 唯一索引仍兜底「同 ref 不重复行」。
 *
 * @returns MaterializeResult（added + freshRefs）。
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
    .where(eq(practice_stream_item.date, plan.date));
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
            // YUK-361 Phase 1：选题信号快照，缺省 {}（零行为变更）。
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
  //    新插入的 fresh 行已落在正确 position，不在此重排。
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
 * 解析当次选题策略。默认 `DEFAULT_SELECTION_POLICY`（'softmax_mfi'，owner default-ON）；
 * 环境变量 `SELECTION_POLICY=legacy` 强制走确定性 composeDailyStream——测试 + 紧急关闭
 * 开关（impl plan Step C「env override 强制 legacy」）。未识别值落默认（不 fail-fast，
 * 选题不能因配置 typo 挂）。
 */
export function resolveSelectionPolicy(): SelectionPolicyConfig {
  const raw = process.env.SELECTION_POLICY;
  if (raw === 'legacy') return { policy: 'legacy' };
  if (raw === 'softmax_mfi') return { policy: 'softmax_mfi' };
  return { policy: DEFAULT_SELECTION_POLICY };
}

/**
 * 按 policy 编排 + 物化 + 记 π_i。两条路径：
 *   - legacy：确定性 composeDailyStream → materialize。π_i 不记。
 *   - softmax_mfi：composeSoftmaxStream（含两级 fallback，永不 throw）→ materialize →
 *     对每个被 sampler 抽中的非到期项 recordSelectionObservation（π_i + policy +
 *     signals snapshot + streamItemId=物化行 id）。到期项 π_i=1 确定性、非随机抽样
 *     ——**不记**（IPW 只关心被抽样的非到期项；记 π_i=1 会污染 active-PPI 的方差估计）。
 *
 * 返回新增行数（与旧 materializeStream 契约一致）。
 */
async function composeMaterializeAndObserve(
  db: DbLike,
  date: string,
  policy: SelectionPolicyConfig,
  deps: ComposeSoftmaxDeps = {},
  capacity?: ComposerInputs['capacity'],
): Promise<number> {
  const inputs = await collectComposerInputs(db, date);
  // 容量注入（DI，测试用——production 不传，走 composeSoftmaxStream 的 DEFAULT_WARN/MAX）。
  //   收紧 max 可让 targetCount < 候选数，使 π_i 真正 < 1（区分不同权重的候选），并行
  //   测 capacityGuard 的 slice 路径（G2/G3/G4）。
  if (capacity) inputs.capacity = capacity;

  if (policy.policy === 'legacy') {
    const { added } = await materializeStream(db, composeDailyStream(inputs), 'composer_live');
    return added;
  }

  // softmax_mfi：永不 throw（两级 fallback 兜底）。
  const result: ComposeSoftmaxResult = await composeSoftmaxStream(db, inputs, policy, deps);
  const { added, freshRefs } = await materializeStream(db, result.plan, 'composer_live');

  // π_i 持久化：只对**本轮新物化**的被抽中非到期项（CLUSTER A 修复）。
  //   result.sampledInclusion 含本轮被抽中的所有非到期 ref，但 recompose 时存活的
  //   done/in_progress 行会被 collectComposerInputs 重新收集 → 重新抽中 → 落进
  //   sampledInclusion；它们**不是本轮新发生的选题**（materializeStream 的 onConflict 没
  //   重插它们），故不在 freshRefs 里——绝不能再对那条**陈旧的存活行 id**写一条幻影/重复
  //   观测（会污染 π_i 慢热资产）。只观测 freshRefs ∩ sampledInclusion。
  //
  //   需要物化行 id：重读当日流按 ref_id 取（截断后被砍的项已从 inclusion map 移除）。
  if (result.sampledInclusion.size > 0 && freshRefs.size > 0) {
    const rows = await db
      .select({ id: practice_stream_item.id, ref_id: practice_stream_item.ref_id })
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, date));
    const idByRef = new Map(rows.map((r) => [r.ref_id, r.id]));
    for (const [refId, pi] of result.sampledInclusion) {
      // 只记本轮新插入的项——存活行的观测在它首次物化那轮已写过。
      if (!freshRefs.has(refId)) continue;
      const streamItemId = idByRef.get(refId);
      const signal = result.signalByRef.get(refId);
      try {
        await recordSelectionObservation(db, {
          date,
          streamItemId,
          refKind: 'question',
          refId,
          policy: 'softmax_mfi',
          selected: true,
          inclusionProbability: pi,
          signals: (signal as unknown as Record<string, unknown>) ?? {},
        });
      } catch (err) {
        // 遥测写失败不该挂选题（telemetry-only）——记日志继续。
        console.error('[stream-store] recordSelectionObservation failed', { refId, pi, err });
      }
    }
  }

  return added;
}

/**
 * Single-flight compose（CLUSTER C 修复）——把 compose+materialize+observe 包进一个事务，
 * 事务内先抢一把 `pg_advisory_xact_lock(hashtext('stream:compose:<date>'))`（同 submit.ts/
 * paper-submit.ts 的 FSRS 锁同款），再做**双重检查**：拿到锁后重读当日行，若已非空说明
 * 竞态的赢家已 compose 过，本调用 no-op 返回（不再二次调 LLM / 不再插重复 position /
 * 不再写重复 π_i 观测）。锁随事务释放（xact 锁，commit/rollback 自动解）。
 *
 * 为什么需要：getStream 的 lazy-compose 与 recompose 都「读行→（空则）compose→materialize」，
 * 之前无锁——两个并发请求都看到空、都调 LLM、都 materialize，导致双倍 LLM 调用 + 重复
 * position + 重复观测。advisory 锁把这段串行化成单飞。
 *
 * @returns 新增行数（compose 真正发生时 = composeMaterializeAndObserve 的 added；竞态输家
 *          no-op 时 = 0）。
 */
async function singleFlightCompose(
  db: Db,
  date: string,
  policy: SelectionPolicyConfig,
  deps: ComposeSoftmaxDeps,
  capacity?: ComposerInputs['capacity'],
): Promise<number> {
  return db.transaction(async (tx) => {
    // 事务级 advisory 锁，键 = 'stream:compose:<date>'。同日的并发 compose 串行化。
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${date}`}))`);

    // 双重检查：拿到锁后重读。赢家已 compose ⇒ 行非空 ⇒ 输家 no-op（不重 compose）。
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, date));
    if (count > 0) return 0;

    return composeMaterializeAndObserve(tx, date, policy, deps, capacity);
  });
}

export interface StreamView {
  date: string;
  opening_line: string;
  items: Array<{
    id: string;
    position: number;
    item_kind: 'question' | 'paper';
    ref_id: string;
    source: StreamItemRow['source'];
    reasoning: string;
    status: StreamItemStatus;
  }>;
  progress: { done: number; total: number };
}

/**
 * 读当日流；为空且 composeIfEmpty 时 lazy compose（首次打开练习面的默认路径）。
 *
 * 选题路径由 `opts.policy`（缺省 `resolveSelectionPolicy()`，读 env / 默认 softmax_mfi）
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
  } = {},
): Promise<StreamView> {
  let rows = await db
    .select()
    .from(practice_stream_item)
    .where(eq(practice_stream_item.date, date))
    .orderBy(asc(practice_stream_item.position));

  if (rows.length === 0 && opts.composeIfEmpty) {
    // CLUSTER C：single-flight（advisory 锁 + 双重检查）——并发 lazy-compose 不双发 LLM。
    await singleFlightCompose(
      db,
      date,
      opts.policy ?? resolveSelectionPolicy(),
      opts.composeDeps ?? {},
      opts.capacity,
    );
    rows = await db
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, date))
      .orderBy(asc(practice_stream_item.position));
  }

  const done = rows.filter((r) => r.status === 'done').length;
  return {
    date,
    // M2 模板开场白；M4 由 composer_nightly 写 AI 开场白（随流持久化）。
    opening_line:
      rows.length === 0
        ? '今天流里还没有东西——录几道题，或向我点播一份卷。'
        : '今天的流我排好了——从上往下做，卡住随时叫我。',
    items: rows.map((r) => ({
      id: r.id,
      position: r.position,
      item_kind: r.item_kind,
      ref_id: r.ref_id,
      source: r.source,
      reasoning: r.reasoning,
      status: r.status,
    })),
    progress: { done, total: rows.length },
  };
}

const LEGAL_TRANSITIONS: Record<StreamItemStatus, StreamItemStatus[]> = {
  pending: ['in_progress', 'done', 'skipped'],
  in_progress: ['done', 'pending', 'skipped'],
  // 捡回（设计稿「跳过 · 流尾可回头」）
  skipped: ['pending', 'in_progress'],
  done: [],
};

/** 推进 item 状态（作答事实由 submit 路由写 event；这里只动日程行）。 */
export async function advanceStreamItem(
  db: Db,
  id: string,
  next: StreamItemStatus,
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
  const [updated] = await db
    .update(practice_stream_item)
    .set({ status: next, updated_at: new Date() })
    .where(eq(practice_stream_item.id, id))
    .returning();
  return updated ?? null;
}

/**
 * 手动重排：保留 done/in_progress/skipped，删 pending 后按当前信号重新编排追加。
 * 选题路径同 getStream（policy 缺省 resolveSelectionPolicy）；softmax_mfi 路径记 π_i。
 *
 * CLUSTER C：delete + compose + materialize 全包进一个事务，事务内先抢
 * `pg_advisory_xact_lock('stream:compose:<date>')`——与 getStream 的 lazy-compose 共用**同一
 * 把锁键**，故 lazy-compose 与 recompose 互斥、并发 recompose 也串行化（不双发 LLM、不插重复
 * position、不写重复 π_i 观测）。recompose 是显式用户动作，拿锁后不做「空则 no-op」双重检查
 * （它本就要在存活行之上重排）——锁只负责串行化。CLUSTER A/B 修复保证串行重排幂等。
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
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${date}`}))`);
    await tx
      .delete(practice_stream_item)
      .where(and(eq(practice_stream_item.date, date), eq(practice_stream_item.status, 'pending')));
    return composeMaterializeAndObserve(
      tx,
      date,
      opts.policy ?? resolveSelectionPolicy(),
      opts.composeDeps ?? {},
      opts.capacity,
    );
  });
}
