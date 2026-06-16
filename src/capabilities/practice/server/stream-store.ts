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
import type { Db } from '@/db/client';
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

const DUE_INPUT_LIMIT = 10;
const VARIANT_WINDOW_DAYS = 7;

async function knowledgeLabels(db: Db, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function collectComposerInputs(db: Db, date: string): Promise<ComposerInputs> {
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

/** 物化 StreamPlan（追加模式：position 接在当日已有项之后；date+ref 唯一索引兜底重复）。 */
export async function materializeStream(
  db: Db,
  plan: StreamPlan,
  addedBy: StreamItemRow['added_by'],
): Promise<number> {
  if (plan.items.length === 0) return 0;
  const existing = await db
    .select({ ref_id: practice_stream_item.ref_id, position: practice_stream_item.position })
    .from(practice_stream_item)
    .where(eq(practice_stream_item.date, plan.date));
  const existingRefs = new Set(existing.map((r) => r.ref_id));
  const base = existing.reduce((m, r) => Math.max(m, r.position), 0);

  const fresh = plan.items.filter((it) => !existingRefs.has(it.ref_id));
  if (fresh.length === 0) return 0;
  const now = new Date();
  await db
    .insert(practice_stream_item)
    .values(
      fresh.map((it, i) => ({
        id: newId(),
        date: plan.date,
        position: base + i + 1,
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
      })),
    )
    .onConflictDoNothing();
  return fresh.length;
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
  db: Db,
  date: string,
  policy: SelectionPolicyConfig,
  deps: ComposeSoftmaxDeps = {},
): Promise<number> {
  const inputs = await collectComposerInputs(db, date);

  if (policy.policy === 'legacy') {
    return materializeStream(db, composeDailyStream(inputs), 'composer_live');
  }

  // softmax_mfi：永不 throw（两级 fallback 兜底）。
  const result: ComposeSoftmaxResult = await composeSoftmaxStream(db, inputs, policy, deps);
  const added = await materializeStream(db, result.plan, 'composer_live');

  // π_i 持久化：只对被抽中的非到期项（result.sampledInclusion）。需要物化行 id ——
  // 重读当日流，按 ref_id 取已物化的 stream_item_id（截断后被砍的项已从 inclusion map
  // 移除，不会在这里查不到）。
  if (result.sampledInclusion.size > 0) {
    const rows = await db
      .select({ id: practice_stream_item.id, ref_id: practice_stream_item.ref_id })
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, date));
    const idByRef = new Map(rows.map((r) => [r.ref_id, r.id]));
    for (const [refId, pi] of result.sampledInclusion) {
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
  } = {},
): Promise<StreamView> {
  let rows = await db
    .select()
    .from(practice_stream_item)
    .where(eq(practice_stream_item.date, date))
    .orderBy(asc(practice_stream_item.position));

  if (rows.length === 0 && opts.composeIfEmpty) {
    await composeMaterializeAndObserve(
      db,
      date,
      opts.policy ?? resolveSelectionPolicy(),
      opts.composeDeps ?? {},
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
 */
export async function recomposeStream(
  db: Db,
  date: string,
  opts: { policy?: SelectionPolicyConfig; composeDeps?: ComposeSoftmaxDeps } = {},
): Promise<number> {
  await db
    .delete(practice_stream_item)
    .where(and(eq(practice_stream_item.date, date), eq(practice_stream_item.status, 'pending')));
  return composeMaterializeAndObserve(
    db,
    date,
    opts.policy ?? resolveSelectionPolicy(),
    opts.composeDeps ?? {},
  );
}
