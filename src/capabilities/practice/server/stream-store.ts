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
import { and, asc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import { QuestionKind } from '@/core/schema/business';
import type { QuestionKindT } from '@/core/schema/judge-routing';
import {
  type CandidateInput,
  type CollectedSignal,
  collectCandidateSignals,
} from './candidate-signals';
import { handleReviewDue } from './due-list';
import { FRONTIER_MAX_ITEMS, learnableFrontier } from './learnable-frontier';
import { getPracticeList } from './practice-read';
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
  newCheckReasoning,
  statisticalWeights,
  variantReasoning,
} from './softmax-selection';
import { type ComposerInputs, type StreamPlan, composeDailyStream } from './stream-composer';

export type StreamItemRow = typeof practice_stream_item.$inferSelect;
export type StreamItemStatus = StreamItemRow['status'];

/**
 * 用户本地日历日（YYYY-MM-DD），**显式锁定 Asia/Shanghai 时区**——「今天的练习流」的唯一
 * 真相源（FINDING 4，Codex）。
 *
 * 为什么不能用进程本地时区（`toLocaleDateString('sv-SE')` 无 timeZone 选项）：
 *   - 夜间预产 cron 在 **Asia/Shanghai** 触发（manifest.ts: `'30 5 * * *', tz: 'Asia/Shanghai'`）。
 *     在 **UTC 容器**里（NAS/prod 默认），05:30 上海 = 前一日 21:30 UTC → 进程本地日是**前一天**
 *     → 夜间 job 给**错误的日期**预产流。
 *   - 读路径（api/stream.ts:resolveDate 的「today」）也要用同一时区，否则夜间产 date-A、用户
 *     首读 lazy-compose 算出 date-B → 各产一份流（double-compose / 互不命中双重检查）。
 *
 * 单用户工具，用户时区固定 Asia/Shanghai；与既有 SQL 侧 `now() at time zone 'Asia/Shanghai'`
 * （workbench-summary.ts）+ 所有夜链 cron 的 `tz: 'Asia/Shanghai'` 一致。读路径与夜间预产**都**
 * 走本 helper → 两条路径对「今天是哪天」恒一致（幂等前提）。
 */
export function streamLocalDate(now: Date = new Date()): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** 本模块的 DB 句柄：既可是顶层 `db`，也可是事务内 `tx`（single-flight 锁需要事务）。 */
type DbLike = Db | Tx;

// ADR-0037 H8 (due-must-review) — due is a HARD constraint: the merge engine may reorder
// / de-emphasize but MUST NOT drop a due item from the queue. So feed it the /api/review/due
// endpoint's FULL ceiling (200, the clamp in due-list.ts) rather than a small slice. The
// old `10` silently dropped due #11+ BEFORE the engine (capacityGuard, which protects due
// from truncation past capacity) ever saw them — an unenforced invariant (YUK-349).
const DUE_INPUT_LIMIT = 200;
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
  // 红线 4（draft 排除契约，YUK-350）：通用练习池的选题候选**必须排除** draft_status='draft'。
  //   谓词与 due-list.ts 的 notDraftQuiz 同形（NULL≡active / 'active' 留池，仅排 'draft'；NULL 需
  //   显式 isNull，否则 `<> 'draft'` 在三值逻辑下会误丢 NULL 行）。new_check + frontier 共用。
  const notDraft = or(isNull(question.draft_status), ne(question.draft_status, 'draft'));

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
      // 每个未检验知识点取一道题（JSONB 包含查询，非 draft 题——见函数顶 notDraft 注释）。
      // new_check 在「KC 还没 material_fsrs_state 行」时触发——此时刚生成的 embedded/teaching
      // draft 题（container-only）还没被任何 review 路径物化，若不过滤会被这里抓成第一题、暴露
      // 给用户成普通练习项。
      for (const kid of untracked) {
        const [q] = await db
          .select({ id: question.id })
          .from(question)
          .where(and(sql`${question.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`, notDraft))
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

  // 5. B3 learnable_frontier（YUK-349 #3）——前置全掌握、自身未掌握的「可学前沿」KC，各取
  //    一道**非 draft** active 题（谓词与 new_check 同形 notDraft——红线 4）。frontier KC 无题 →
  //    SKIP（不触发供给）。NO-OP：稀疏先决图上 learnableFrontier 返 [] → frontierPairs=[]（
  //    defer-flip，无 flag——见 learnable-frontier.ts 不变量块）。
  const frontierKcs = await learnableFrontier(db);
  const frontierPairs: Array<{ questionId: string; knowledgeId: string }> = [];
  for (const kc of frontierKcs.slice(0, FRONTIER_MAX_ITEMS)) {
    const [q] = await db
      .select({ id: question.id })
      .from(question)
      .where(and(sql`${question.knowledge_ids} @> ${JSON.stringify([kc])}::jsonb`, notDraft))
      // Deterministic pick (reproducible composition) — the new_check sibling omits this;
      // frontier is net-new so we make it stable from the start.
      .orderBy(question.id)
      .limit(1);
    if (q) frontierPairs.push({ questionId: q.id, knowledgeId: kc });
  }

  // 标签批量解析（reasoning 模板用）。
  const labelMap = await knowledgeLabels(db, [
    ...dueRows.flatMap((r) => r.knowledge_ids ?? []).slice(0, 50),
    ...newCheckPairs.map((p) => p.knowledgeId),
    ...frontierPairs.map((p) => p.knowledgeId),
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
    frontierItems: frontierPairs.map((p) => ({
      questionId: p.questionId,
      knowledgeId: p.knowledgeId,
      knowledgeLabel: labelMap.get(p.knowledgeId),
    })),
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
 * ⚠️ **隐含依赖：`(date, position)` 必须保持 NON-UNIQUE**（schema.ts 只有 `(date, ref_id)`
 * 唯一）。本函数顺序 renumber 存活行时会有**瞬态**同 position（两行换位的中间态），最终态
 * 才唯一。若将来给 `(date, position)` 加 uniqueIndex，reorder-survivor 会在 compose tx 里
 * mid-loop 抛 23505——加唯一索引前必须先改成「先腾位再落位」或临时偏移。
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
 * compose+materialize 在事务内的结果：新增行数 + **待写的选题观测元组**（FINDING B）。
 *
 * 观测**不**在事务内写——见 composeMaterializeCollect / singleFlightCompose 的 FINDING B
 * 解耦说明。事务内只把 (streamItemId, refId, π_i, signals) 元组**收集**起来，由调用方在
 * **事务提交后**（锁外，best-effort）落库，使遥测写失败永不回滚已物化的流。
 */
interface ComposeOutcome {
  /** 新增行数（与旧 materializeStream 契约一致）。 */
  added: number;
  /** 待写选题观测（事务提交后落库；softmax_mfi 路径才非空，legacy 恒空）。 */
  observations: SelectionObservationInput[];
}

/**
 * 按 policy 编排 + 物化 + **收集**（不写）π_i 观测。两条路径：
 *   - legacy：确定性 composeDailyStream → materialize。π_i 不记（observations 空）。
 *   - softmax_mfi：composeSoftmaxStream（含两级 fallback，永不 throw）→ materialize →
 *     **收集**每个被 sampler 抽中的非到期项的观测元组（π_i + policy + signals snapshot +
 *     streamItemId=物化行 id）。到期项 π_i=1 确定性、非随机抽样——**不收集**（IPW 只关心
 *     被抽样的非到期项；记 π_i=1 会污染 active-PPI 的方差估计）。
 *
 * ⚠️ FINDING B：本函数**只收集不写**观测。它跑在 single-flight 锁事务内（singleFlightCompose
 *   / recomposeStream 的 `db.transaction`）——若在事务内 INSERT selection_observation 且 INSERT
 *   抛错，Postgres 会把**整个事务**标记为 aborted，try/catch 记日志也救不回，提交时整笔回滚
 *   → 刚物化的 practice_stream 一起没了（违反「遥测失败不得破坏选题」）。故把观测元组**带出
 *   事务**，由调用方在提交后锁外 best-effort 落库（见 writeObservationsBestEffort）。
 */
async function composeMaterializeCollect(
  db: DbLike,
  date: string,
  policy: SelectionPolicyConfig,
  deps: ComposeSoftmaxDeps = {},
  capacity?: ComposerInputs['capacity'],
  // Task 9：物化行的 `added_by` 来源标注（lazy-compose / recompose = 'composer_live'；
  //   夜间预产 job = 'composer_nightly'）。两条路径共用本函数（DRY，不分叉 compose 逻辑），
  //   只此参数不同——区分流是用户首读懒产的还是夜链 AI 预产的（D14 夜链开场白归属）。
  addedBy: StreamItemRow['added_by'] = 'composer_live',
): Promise<ComposeOutcome> {
  const inputs = await collectComposerInputs(db, date);
  // 容量注入（DI，测试用——production 不传，走 composeSoftmaxStream 的 DEFAULT_WARN/MAX）。
  //   收紧 max 可让 targetCount < 候选数，使 π_i 真正 < 1（区分不同权重的候选），并行
  //   测 capacityGuard 的 slice 路径（G2/G3/G4）。
  if (capacity) inputs.capacity = capacity;

  if (policy.policy === 'legacy') {
    const { added } = await materializeStream(db, composeDailyStream(inputs), addedBy);
    return { added, observations: [] };
  }

  // softmax_mfi：永不 throw（两级 fallback 兜底）。
  const result: ComposeSoftmaxResult = await composeSoftmaxStream(db, inputs, policy, deps);
  const { added, freshRefs } = await materializeStream(db, result.plan, addedBy);

  // π_i 收集：只对**本轮新物化**的被抽中非到期项（CLUSTER A 修复）。
  //   result.sampledInclusion 含本轮被抽中的所有非到期 ref，但 recompose 时存活的
  //   done/in_progress 行会被 collectComposerInputs 重新收集 → 重新抽中 → 落进
  //   sampledInclusion；它们**不是本轮新发生的选题**（materializeStream 的 onConflict 没
  //   重插它们），故不在 freshRefs 里——绝不能再对那条**陈旧的存活行 id**写一条幻影/重复
  //   观测（会污染 π_i 慢热资产）。只收集 freshRefs ∩ sampledInclusion。
  //
  //   需要物化行 id：重读当日流按 ref_id 取（截断后被砍的项已从 inclusion map 移除）。
  const observations: SelectionObservationInput[] = [];
  if (result.sampledInclusion.size > 0 && freshRefs.size > 0) {
    const rows = await db
      .select({ id: practice_stream_item.id, ref_id: practice_stream_item.ref_id })
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, date));
    const idByRef = new Map(rows.map((r) => [r.ref_id, r.id]));
    for (const [refId, pi] of result.sampledInclusion) {
      // 只收集本轮新插入的项——存活行的观测在它首次物化那轮已写过。
      if (!freshRefs.has(refId)) continue;
      const signal = result.signalByRef.get(refId);
      observations.push({
        date,
        streamItemId: idByRef.get(refId),
        refKind: 'question',
        refId,
        policy: 'softmax_mfi',
        selected: true,
        inclusionProbability: pi,
        signals: (signal as unknown as Record<string, unknown>) ?? {},
      });
    }
  }

  return { added, observations };
}

/**
 * FINDING B：在 single-flight 锁事务**提交后**（锁外）best-effort 落选题观测。
 *
 * 用顶层 `db`（**非** tx）逐条写——这样一条观测写失败只丢那一条遥测，既不影响已提交的
 * 物化流，也不影响其余观测（每条独立 try/catch）。遥测是 telemetry-only：失败记日志继续，
 * 永不 throw 出去、永不回滚选题。π_i 慢热资产因此可能漏极少数条（已记日志可补），但选题
 * 路径的可用性绝不被遥测拖垮——这正是「遥测失败不得破坏选题」契约的落地。
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
 * Single-flight compose（CLUSTER C 修复）——把 compose+materialize 包进一个事务，
 * 事务内先抢一把 `pg_advisory_xact_lock(hashtext('stream:compose:<date>'))`（同 submit.ts/
 * paper-submit.ts 的 FSRS 锁同款），再做**双重检查**：拿到锁后重读当日行，若已非空说明
 * 竞态的赢家已 compose 过，本调用 no-op 返回（不再二次调 LLM / 不再插重复 position /
 * 不再写重复 π_i 观测）。锁随事务释放（xact 锁，commit/rollback 自动解）。
 *
 * 为什么需要：getStream 的 lazy-compose 与 recompose 都「读行→（空则）compose→materialize」，
 * 之前无锁——两个并发请求都看到空、都调 LLM、都 materialize，导致双倍 LLM 调用 + 重复
 * position + 重复观测。advisory 锁把这段串行化成单飞。
 *
 * FINDING B：选题观测（π_i）**不在事务内写**——事务只 compose+materialize 并**带出**待写
 * 观测元组，提交后由 writeObservationsBestEffort 在**锁外** best-effort 落库。遥测写失败因此
 * 永不回滚已物化的流（事务内 INSERT 抛错会 abort 整笔事务，try/catch 也救不回）。
 *
 * @returns 新增行数（compose 真正发生时 = composeMaterializeCollect 的 added；竞态输家
 *          no-op 时 = 0）。
 */
async function singleFlightCompose(
  db: Db,
  date: string,
  policy: SelectionPolicyConfig,
  deps: ComposeSoftmaxDeps,
  capacity?: ComposerInputs['capacity'],
  // Task 9：物化来源标注。lazy-compose / recompose 传 'composer_live'（缺省）；
  //   夜间预产 job 经 composeNightly 传 'composer_nightly'。双重检查 + 单飞锁不变，
  //   只 addedBy 透传到 composeMaterializeCollect。
  addedBy: StreamItemRow['added_by'] = 'composer_live',
): Promise<number> {
  const { added, observations } = await db.transaction(async (tx) => {
    // 事务级 advisory 锁，键 = 'stream:compose:<date>'。同日的并发 compose 串行化。
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${date}`}))`);

    // 双重检查：拿到锁后重读。赢家已 compose ⇒ 行非空 ⇒ 输家 no-op（不重 compose）。
    // Task 9 幂等核心：夜间 job 与用户首读 lazy-compose 共用此锁 + 双重检查——夜间先产
    //   ⇒ 当日行非空 ⇒ 用户首读 lazy 命中双重检查 no-op（不二次 compose、不双发 LLM、
    //   不插重复 position / 重复 π_i）。反向（用户先读再夜间 job）亦同：夜间 job 经
    //   composeNightly 自己也做「已物化则 no-op」双重检查（见 composeNightly）。
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, date));
    if (count > 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    return composeMaterializeCollect(tx, date, policy, deps, capacity, addedBy);
  });

  // 事务已提交（流已稳）——锁外 best-effort 写观测；失败只丢遥测，绝不回滚流（FINDING B）。
  await writeObservationsBestEffort(db, observations);
  return added;
}

/**
 * Task 9 夜间预产入口——夜链 job（practice_stream_compose_nightly）调用本函数为「今天」
 * 预产流。与用户首读的 lazy-compose **共用 singleFlightCompose 的同一把单飞锁 + 双重检查**
 * （DRY：不分叉 compose 逻辑），唯一区别是物化行 `added_by='composer_nightly'`。
 *
 * 幂等（双重检查 under lock）：若今天的流已物化（夜间已跑过、或用户已首读懒产），
 * singleFlightCompose 的双重检查命中 count>0 → no-op 返回 0，不二次 compose。故
 *   - 夜间 job 跑两次：第二次 no-op。
 *   - 夜间 job 跑完用户首读：lazy-compose 命中双重检查 no-op（不 double-compose）。
 *   - 用户先首读再夜间 job：夜间 job 命中双重检查 no-op（不覆盖已产流）。
 *
 * @returns 新增行数（真正预产时 = composeMaterializeCollect 的 added；已物化时 = 0）。
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

/**
 * 推进 item 状态（作答事实由 submit 路由写 event；这里只动日程行）。
 *
 * Task 9（hybrid 运行时）：题项推进到 `done` 后触发**有界增量重排**（reRankAfterAnswer）
 * ——作答更新了该题 knowledge_ids 的 θ̂（submit 路由的 updateThetaForAttempt），触及这些 KC
 * 的**待做非到期诊断项**的 MFI 权重随之变化，需据更新后 θ̂ 重排它们（only 它们）。
 * **仅 softmax_mfi policy 触发**（FINDING 3）：SELECTION_POLICY=legacy 紧急关闭开关下整体
 * 跳过随机重排（legacy 走确定性 composeDailyStream，不容随机 IPPS 扰动）。
 *
 * 同步 vs 异步 / 重排触发的设计抉择（task 9 deliverable 2）：
 *   - 选 **best-effort 同步**（状态 UPDATE 提交后、本函数返回前 inline 调），**包在 try/catch
 *     里永不 throw**——与 writeObservationsBestEffort 的 post-commit 遥测同纪律。理由：
 *     ① 重排走**纯统计 sampler**（不重跑 LLM，见 reRankAfterAnswer），廉价；② 它在自己的
 *     单飞锁事务里跑（与作答 UPDATE 解耦），重排失败/抛错绝不回滚已落库的状态推进、也不让
 *     PATCH 路由 500；③ 不引新 pg-boss 队列（scope discipline）。代价：PATCH 响应多等一个
 *     轻量统计重排（无 LLM 网络往返）——可接受。
 *   - 未选异步 fire-and-forget（boss.send 新队列）：增量重排无 LLM、毫秒级，独立队列的运维
 *     成本 + 新 schema 面不划算；best-effort 同步已满足「不破坏/不显著拖慢作答写」。
 */
export async function advanceStreamItem(
  db: Db,
  id: string,
  next: StreamItemStatus,
  // 重排 DI（测试注入 rng 确定化 Poisson 抽样）。production 省略 → 默认 Math.random。
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
  const [updated] = await db
    .update(practice_stream_item)
    .set({ status: next, updated_at: new Date() })
    .where(eq(practice_stream_item.id, id))
    .returning();
  if (!updated) return null;

  // Task 9：作答推进到 done 的**题项**触发有界增量重排（best-effort，post-commit）。
  //   只 question 项（paper 内部题不在流层重排）；只 done（in_progress/skipped/pending 不触发）。
  //
  // FINDING 3（Codex）：尊重 SELECTION_POLICY=legacy 紧急关闭开关。legacy 路径走确定性
  //   composeDailyStream（无随机 softmax / 无 IPPS 重排）——增量重排（reRankAfterAnswer）是
  //   softmax_mfi 专属的随机重抽样层，legacy 下**必须整体跳过**，否则确定性 compose 出来的流
  //   会被 softmax 重排偷偷扰动（违背 legacy「关掉所有随机选题」的语义）。
  const policyForRerank = resolveSelectionPolicy().policy;
  if (
    policyForRerank === 'softmax_mfi' &&
    updated.status === 'done' &&
    updated.item_kind === 'question'
  ) {
    try {
      await reRankAfterAnswer(db, {
        date: updated.date,
        answeredQuestionId: updated.ref_id,
        rng: rerankDeps.rng,
      });
    } catch (err) {
      // 重排是 hybrid 运行时的便利层，失败绝不破坏已提交的状态推进（best-effort 契约）。
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
 * 手动重排：保留 done/in_progress/skipped，删 pending 后按当前信号重新编排追加。
 * 选题路径同 getStream（policy 缺省 resolveSelectionPolicy）；softmax_mfi 路径记 π_i。
 *
 * CLUSTER C：delete + compose + materialize 全包进一个事务，事务内先抢
 * `pg_advisory_xact_lock('stream:compose:<date>')`——与 getStream 的 lazy-compose 共用**同一
 * 把锁键**，故 lazy-compose 与 recompose 互斥、并发 recompose 也串行化（不双发 LLM、不插重复
 * position、不写重复 π_i 观测）。recompose 是显式用户动作，拿锁后不做「空则 no-op」双重检查
 * （它本就要在存活行之上重排）——锁只负责串行化。CLUSTER A/B 修复保证串行重排幂等。
 *
 * FINDING B：与 singleFlightCompose 同款——选题观测在事务**提交后**锁外 best-effort 写，
 * 遥测失败永不回滚已重排物化的流。
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
  const { added, observations } = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${date}`}))`);
    await tx
      .delete(practice_stream_item)
      .where(and(eq(practice_stream_item.date, date), eq(practice_stream_item.status, 'pending')));
    return composeMaterializeCollect(
      tx,
      date,
      opts.policy ?? resolveSelectionPolicy(),
      opts.composeDeps ?? {},
      opts.capacity,
    );
  });

  // 事务已提交（流已稳）——锁外 best-effort 写观测（FINDING B）。
  await writeObservationsBestEffort(db, observations);
  return added;
}

// ═══════════════════════════════════════════════════════════════════════════
// Task 9（hybrid 运行时核心）：作答后有界增量重排。
// ═══════════════════════════════════════════════════════════════════════════
//
// 作答把答对题的 knowledge_ids 的 θ̂ 推动了（submit 路由 updateThetaForAttempt）。触及这些
// KC 的**待做非到期诊断项**（frontier/diagnostic/new_check）的 MFI 权重 = p(1−p)、p=σ(θ̂−b)
// 随之改变——需据**更新后** θ̂ 重排它们。这就是 ADR-0042 §4 hybrid（夜间预产骨架 + 作答后
// 增量重排）的「增量重排」半边：只重跑**受影响 KC** 的 L1 信号（重读 mastery_state → 新 θ̂）
// + 薄统计 sampler，**不整流、不重跑 LLM**（ADR-0042 §4 amendment「增量重排走纯统计 sampler，
// 若不重跑 LLM 则用上次 LLM 权重 + 新信号，便宜」——本实现取「新信号纯统计 sampler」档：
// LLM 权重未逐项持久化，最便宜且正确的是用更新后 θ̂ 重算 mfiScore 当统计权重重抽样）。
//
// ─── 候选池重设计（YUK-361 Phase 4 HIGH 缺陷修复）────────────────────────────────
//   **以前的 bug**：候选池只取「受影响的既有流行」（candidateInputs = affectedRows.map），
//   且 targetCount = affectedRows.length。pool 数 N === targetCount → inclusionProbabilities
//   命中退化档（targetCount ≥ N → 全 π_i=1）→ sampler 原样重选同一集合 → delete+reinsert
//   同 ref（churn + 新行 id），**一道都没真重排**，还往 IPW 资产灌 π=1 脏行。deliverable(2)
//   「按更新后 θ̂ 重排待做非到期项」沦为 no-op。
//
//   **修复**：把候选池**拓宽**成「当日完整 eligible 非到期池」——复用 collectComposerInputs 的
//   variant + new_check 源（与 Phase 3 选题同源），再**排除所有 FROZEN/ineligible ref**：
//     - 到期行（source='decay'）、recall-locked 行、done/in_progress/skipped 行（任意 source）、
//       今日已物化且已完成的 ref——都不进池（它们冻结，position/status 不动）。
//   这个 broad pool 的大小 N **大于** targetCount（= 当前待做非到期空位数），故 sampleByWeight
//   走**真** IPPS（π_i < 1，真重排：可换进一道现在更诊断的题、换掉一道现在更不诊断的）。新鲜
//   θ̂（collectCandidateSignals 读当前 mastery_state）这下真的改变结果。
//
//   targetCount = **当前待做非到期空位数**（待回填的诊断尾长），**不是** pool 大小。
//
// ─── 不变量保全（与 Phase 3 选题路径 review 同款铁律②③④ + positivity）────────────
//   ② 到期 presence + intra-day 序：到期行（source='decay'）**冻结**——既不删也不动 position，
//      故其 presence + L1 相对序原样保全（本函数从不碰到期行；它们也被排出候选池）。
//   ③ recall 同题重背：snapshot recall-locked 待做行（signals.recallLocked===true）**冻结**；
//      且**EDGE 2**——某行 snapshot 不是 recall 但**新鲜 compute** 重判为 recall（question.kind
//      变脏 → resolveEnumKind undefined → fail-closed recallLocked=true）时，该行**冻结保留**
//      （不删进空位、不重抽样），presence 守住（never drop-into-a-gap）。
//   ④ 容量 + draft 排除 + dedup：targetCount = 可替换待做非到期 slot 数（不胀容量）；broad pool
//      抽样经 in-memory seen（排除冻结 ref）+ date+ref 唯一索引兜重复。
//   positivity（ADR-0043 §7）：复用 sampleByWeight（含 ε-greedy 下限）——每个进池候选 π_i>0；
//      **EDGE 3**——只对 INSERT **真落库**的行（onConflictDoNothing 没吞掉的）记真 π_i
//      （post-commit best-effort，policy='softmax_mfi'），绝不记幻影 π_i（mirror materializeStream
//      的 freshRefs 纪律）。
//   done/in_progress/skipped 行（任意 source）**冻结**——既不删也不动 position+status。
//
// ─── FINDING 2（Codex）：重排作用域**收窄到答完题的 KC**────────────────────────────
//   只重排「题触及 affectedKnowledgeIds（= 答完那题的 knowledge_ids）」的待做非到期行。答 KC-A
//   绝不去删一个 KC-B 的待做项换成 KC-A 候选（churn 无关 slot）——**不触及答完 KC 的待做非到期
//   行整体冻结**（进 frozenRefs，不删、不动 position、不进候选池）。θ̂ 只为相关 KC 的候选移动，
//   故只有它们该被重排。
//
// ─── FINDING 1（Codex，DATA LOSS）：欠采绝不丢题（只 SWAP 不 SHRINK）──────────────
//   sampleByWeight 是 **Poisson/Bernoulli IPPS**——realized `sampled.length` 在 targetCount 附近
//   **随机波动**，不保证 == 可替换 slot 数。旧实现「先删全部可替换行、再只插 sampled 条」在欠采
//   （sampled < replaceable）时**永久丢掉**待做非到期项（流缩短 + position 空洞）。修复 = Option(a)
//   **只删将被真正回填的 slot**（"don't delete a row you won't refill"）：删除数 = min(本轮真换进
//   的新 ref 数, 可替换 slot 数)，删**最低 position** 的那几个，其余可替换行**原地保留**（不删、不动
//   position）。π_i 含义：每条**真插入**项的 π_i 仍是 sampleByWeight 的**真** Poisson 入选概率
//   （targetCount 不变、不 top-up、不扰动权重）→ 喂 Phase 6 IPW 无偏；保留下来的原 slot 沿用首次
//   物化那轮已记的 π_i（不重写）。
//
// ─── 单飞锁 + 串行化 ───────────────────────────────────────────────────────────
//   复用**同一把** `pg_advisory_xact_lock('stream:compose:<date>')`——与 lazy-compose /
//   recompose / 夜间预产互斥，故重排与任何 compose 路径不会并发改同一天的流（不双写
//   position、不写重复观测）。
//
// ─── policy gate（FINDING 3，advanceStreamItem 侧）─────────────────────────────────
//   advanceStreamItem 只在 resolveSelectionPolicy().policy === 'softmax_mfi' 时调本函数；
//   SELECTION_POLICY=legacy 紧急关闭开关下整体跳过随机重排（legacy 走确定性 composeDailyStream）。
//
// ─── position 模型（done/skipped 行绝不移位的硬约束 ⇒ 不能整流 renumber）──────────
//   只删**真正被回填的**待做非到期行（被 EDGE 2 冻结保留的、KC 无关的、欠采下不回填的都不删），
//   腾出 position「空位」；抽中的新项**优先填这些空位**（按抽样序），多出的追加在 `max(position)+1…`。
//   冻结行 + 保留 slot 的 position 全部**逐字不动**——满足「done/due/recall/in_progress/skipped 保
//   position」+「无重复 position」（空位本就空闲；tail 位超 max 不撞冻结位；空位由删除行让出，不撞
//   冻结位）。这与 materializeStream 的整流 renumber **有意不同**：那条路径会移到期/done 行 position
//   （recompose 语义下可接受）；增量重排契约更严（done 必须钉死），故走专用定位。presence 硬约束：
//   每行重排前存在的，要么 frozen-kept、要么被替换重落，**绝不掉进空位被丢**（欠采下不回填的 slot
//   不删 → 也守住 presence）。

/** 从 practice_stream_item.signals 快照读 recallLocked（Phase 3 物化的 CollectedSignal）。 */
function rowIsRecallLocked(signals: unknown): boolean {
  return (signals as { recallLocked?: unknown } | null)?.recallLocked === true;
}

/** 把 DB question.kind（text，可能脏）收敛成枚举内 QuestionKindT 或 undefined（同 softmax 侧 FINDING 4）。 */
function resolveEnumKind(kind: string | null | undefined): QuestionKindT | undefined {
  const parsed = QuestionKind.safeParse(kind);
  return parsed.success ? (parsed.data as QuestionKindT) : undefined;
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
  opts: { date: string; answeredQuestionId: string; rng?: () => number },
): Promise<number> {
  const { date, answeredQuestionId } = opts;

  // 受影响 KC = 刚答完那题的 knowledge_ids。空 → 无 θ̂ 移动锚点 → no-op（不触发重排）。
  const [answered] = await db
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, answeredQuestionId))
    .limit(1);
  const affectedKnowledgeIds = new Set((answered?.knowledge_ids ?? []).filter(Boolean));
  if (affectedKnowledgeIds.size === 0) return 0;

  const { added, observations } = await db.transaction(async (tx) => {
    // 单飞锁（与所有 compose 路径共用键）——重排与 lazy/recompose/nightly 互斥。
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${date}`}))`);

    const rows = await tx
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, date))
      .orderBy(asc(practice_stream_item.position));
    if (rows.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // ── 待做非到期诊断行（重排作用域的全集）= 当前 pending + question + source(variant/
    //    new_check) + snapshot 非 recall-locked。到期行(decay)/卷/snapshot recall-locked/任何
    //    done|in_progress|skipped 行 = 冻结，它们既不进作用域、也不进候选池、position/status 逐字不动。
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

    // ── FINDING 2（Codex）：把重排作用域**收窄**到「题触及答完题 KC（affectedKnowledgeIds）」的
    //    待做非到期行。答 KC-A 不该把无关的 KC-B 待做项删掉换成 KC-A 候选（churn 无关 slot）——
    //    只有 KC 受 θ̂ 移动影响的待做项才该被重排。**不触及答完 KC 的待做非到期行整体冻结**
    //    （既不进 targetCount、不删、不动 position）。需逐行查 question.knowledge_ids 判定。
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

    // ── HIGH 修复：候选池**拓宽**成「当日完整 eligible 非到期池」（不再只取受影响既有流行）。
    //    复用 collectComposerInputs 的 variant + new_check 源（与 Phase 3 选题同源）；到期项
    //    与卷不进重排候选池（它们冻结/旁路）。
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

    // ── 冻结/ineligible ref 集合：必须从候选池**排除**（它们 position 不动，不得被重抽样
    //    复制成新行 → 撞 date+ref 唯一索引 / 破坏冻结行的 presence）。
    //    = 到期行(decay) + snapshot recall-locked 行 + done|in_progress|skipped 行（任意 source）
    //      + 卷 + **FINDING 2 下「不触及答完 KC」的待做非到期行**（它们也冻结，不进作用域）。
    //    只有 KC-scoped 的 pendingNonDue 的 ref **不在**冻结集（它们正是要被替换的尾，可重新入选）。
    const pendingNonDueRefs = new Set(pendingNonDue.map((r) => r.ref_id));
    const frozenRefs = new Set(
      rows.filter((r) => !pendingNonDueRefs.has(r.ref_id)).map((r) => r.ref_id),
    );

    // 候选池 raws：排除冻结 ref + in-memory dedup（铁律④；唯一索引兜底）。
    const seenPool = new Set<string>();
    const eligibleRaws = poolRaws.filter(
      (r) =>
        !frozenRefs.has(r.questionId) && !seenPool.has(r.questionId) && seenPool.add(r.questionId),
    );
    if (eligibleRaws.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // ── 富化候选（kind/knowledge_ids/difficulty）——一次性批量点查 question 表。
    const poolQids = eligibleRaws.map((r) => r.questionId);
    const candQRows = await tx
      .select({
        id: question.id,
        kind: question.kind,
        knowledge_ids: question.knowledge_ids,
        difficulty: question.difficulty,
        // YUK-372 L3 — question.source for family_key resolution (distinct from the slot
        // `source` in eligibleRaws, which is the stream-slot origin 'decay'/'new_check').
        source: question.source,
      })
      .from(question)
      .where(inArray(question.id, poolQids));
    const candQById = new Map(candQRows.map((q) => [q.id, q]));

    // ── bounded gate（铁律④ + deliverable 5）：只在答完题的 KC 与 eligible 池的 KC 相交时
    //    才重排（θ̂ 真为相关候选移动了）。零相交 → no-op（不 churn、不写观测）。
    const poolTouchesAffected = eligibleRaws.some((r) => {
      const kids = candQById.get(r.questionId)?.knowledge_ids ?? [];
      return kids.some((k) => affectedKnowledgeIds.has(k));
    });
    if (!poolTouchesAffected) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // ── 收集候选信号（**新鲜 θ̂**：collectCandidateSignals 读当前 mastery_state）。
    const sourceByRef = new Map(eligibleRaws.map((r) => [r.questionId, r.source]));
    const labelByRef = new Map(eligibleRaws.map((r) => [r.questionId, r.knowledgeLabel]));
    const candidateInputs: CandidateInput[] = eligibleRaws.map((r) => {
      const q = candQById.get(r.questionId);
      return {
        refKind: 'question' as const,
        refId: r.questionId,
        role: r.source === 'new_check' ? ('new_check' as const) : ('diagnostic' as const),
        kind: resolveEnumKind(q?.kind),
        knowledgeIds: q?.knowledge_ids,
        difficulty: q?.difficulty,
        // YUK-372 L3 — question.source (not the slot source) for family_key resolution.
        source: q?.source,
      };
    });
    const signals: CollectedSignal[] = await collectCandidateSignals(tx, candidateInputs);
    const signalByRef = new Map(signals.map((s) => [s.refId, s]));

    // ── EDGE 2（铁律③ + presence）：某 pendingNonDue 行 snapshot 不是 recall，但**新鲜 compute**
    //    重判为 recall（question.kind 变脏 → resolveEnumKind undefined → fail-closed
    //    recallLocked=true）。这种行**不删进空位、不重抽样**——freeze 保留（position/status 不动），
    //    presence 守住（never drop-into-a-gap）。
    const freshRecallRefs = new Set(
      signals.filter((s) => s.recallLocked === true).map((s) => s.refId),
    );
    // samplable = 非 recall-locked 候选（snapshot 已过滤 + fresh recall 此处剔除）。
    const samplable = signals.filter((s) => s.recallLocked !== true);

    // ── 可被替换的待做非到期行（作用域内、EDGE 2 冻结的 fresh-recall 行排除——保留不删）。
    //    它们是「可换出的 slot」上界；**实际删多少由真正落库的新抽中项数决定**（FINDING 1）。
    const replaceableRows = pendingNonDue
      .filter((r) => !freshRecallRefs.has(r.ref_id))
      .sort((a, b) => a.position - b.position);
    if (replaceableRows.length === 0)
      return { added: 0, observations: [] } satisfies ComposeOutcome;
    const replaceableRefs = new Set(replaceableRows.map((r) => r.ref_id));

    // ── dedup 真相源（铁律④）：抽中项不得撞已在流里且**不会被删**的 ref（frozen + fresh-recall-kept
    //    + 未被替换保留下来的 replaceable 行）。被真正删掉的 replaceable ref 才可重新入选。
    //    keptRefs 在删除决策**之后**重算（见下）；此处先备 baseKeptRefs = 所有非 replaceable ref
    //    （恒不删）。
    const baseKeptRefs = new Set(
      rows.filter((r) => !replaceableRefs.has(r.ref_id)).map((r) => r.ref_id),
    );

    // ── 纯统计 sampler（不跑 LLM，ADR-0042 §4）：用新鲜 θ̂ 的 mfiScore 当权重。
    //    targetCount = 可替换的待做非到期 slot 数（NOT pool 大小）——broad pool N > targetCount，
    //    故 sampleByWeight 走**真** IPPS（π_i<1，真重排）。
    const weighted = statisticalWeights(samplable);
    const sampled =
      weighted.length === 0
        ? []
        : sampleByWeight(weighted, {
            temperature: DEFAULT_TEMPERATURE,
            targetCount: replaceableRows.length,
            rng: opts.rng,
          });

    // ── FINDING 1（Codex，DATA LOSS）：sampleByWeight 是 **Poisson/Bernoulli IPPS**——realized
    //    `sampled.length` 在期望值 targetCount 附近**随机波动**，**不保证** == replaceableRows.length。
    //    旧实现「先删全部 replaceableRows，再只插 sampled 条」在 sampled < replaceable 欠采时
    //    会**永久丢掉**待做非到期项（流缩短 + position 空洞）——选定 Option (a)「只 SWAP，绝不
    //    SHRINK」：**只删将被真正回填的那几个 slot**（"don't delete a row you won't refill"）。
    //    步骤：
    //      1. 先算出本轮**真正会换进的新 ref**（sampled 里 ref ∉ baseKeptRefs、去重）。这是
    //         「能填的新项数」上界。
    //      2. 删除数 = min(新 ref 数, replaceableRows 数)；删**最低 position** 的那几个 slot
    //         （腾出确定的 position 空位回填），其余 replaceable 行**原地保留**（不删、不动 position）。
    //      3. 多出的新 ref（> 删除数）追加在 tail（流可增长，pre-existing 行为，非 shrink）。
    //    π_i 含义：每条**真插入**项记录的 π_i 仍是 sampleByWeight 算出的**真** Poisson 入选概率
    //    （targetCount=replaceableRows.length 不变）——本修复不 top-up、不扰动权重，只是**不删
    //    无回填的 slot**，故 π_i 仍是 realized selection 的真实边际入选概率（喂 Phase 6 IPW 无偏）。
    //    保留下来的原 slot 沿用其首次物化那轮已记的 π_i（不重写）。
    const newRefPicks: string[] = [];
    const seenNewRef = new Set<string>();
    for (const s of sampled) {
      if (baseKeptRefs.has(s.refId)) continue; // 已在流里且不删 → 不是「换进的新项」。
      if (seenNewRef.has(s.refId)) continue; // 去重（同 ref 只占一个 slot）。
      seenNewRef.add(s.refId);
      newRefPicks.push(s.refId);
    }
    // 实际删除的 slot 数 = min(能填的新 ref 数, 可替换 slot 数)——绝不删超过能回填的数量。
    const deleteCount = Math.min(newRefPicks.length, replaceableRows.length);
    const rowsToDelete = replaceableRows.slice(0, deleteCount); // 最低 position 的 deleteCount 个。
    const deletedRefs = new Set(rowsToDelete.map((r) => r.ref_id));
    const vacatedPositions = rowsToDelete.map((r) => r.position).sort((a, b) => a - b);

    // keptRefs = baseKeptRefs ∪ 未被删的 replaceable ref（它们原地保留 → 抽中也不得重插撞唯一索引）。
    const keptRefs = new Set(rows.filter((r) => !deletedRefs.has(r.ref_id)).map((r) => r.ref_id));

    // 无可删 slot（deleteCount==0：欠采到 0 新 ref，或全被 baseKeptRefs 吸收）→ 不删不插，no-op。
    if (rowsToDelete.length === 0) return { added: 0, observations: [] } satisfies ComposeOutcome;

    // ── 只删**将被回填**的 replaceable 行（腾位）。其余 replaceable 行 + 冻结行 + EDGE2 保留行
    //    原封不动——FINDING 1：绝不删一个不会回填的 slot（无 shrink、无 position 空洞）。
    await tx.delete(practice_stream_item).where(
      and(
        eq(practice_stream_item.date, date),
        inArray(
          practice_stream_item.id,
          rowsToDelete.map((r) => r.id),
        ),
      ),
    );

    // ── 落新抽中项：优先填腾出的空位，多出的追加在 max(position)+1…（冻结行 + 保留 slot position 不动）。
    //    dedup：跳过已在 keptRefs 的 ref（避免撞 date+ref 唯一索引）。
    //    EDGE 3：observation + added **仅对 INSERT 真落库的行**（onConflictDoNothing 没吞掉的）
    //    ——mirror materializeStream 的 freshRefs 纪律，绝不记幻影 π_i（streamItemId 必须有真行）。
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
      const source = sourceByRef.get(s.refId) ?? 'variant';
      const newRowId = newId();
      const inserted = await tx
        .insert(practice_stream_item)
        .values({
          id: newRowId,
          date,
          position: pos,
          item_kind: 'question' as const,
          ref_id: s.refId,
          source,
          status: 'pending' as const,
          // 重排不改文案（保留 reasoning 模板——增量重排是排序调整，非新叙事）。
          reasoning:
            source === 'new_check'
              ? newCheckReasoning(labelByRef.get(s.refId))
              : variantReasoning(labelByRef.get(s.refId)),
          added_by: 'composer_live' as const,
          signals: (signal as unknown as Record<string, unknown>) ?? {},
          created_at: now,
          updated_at: now,
        })
        // EDGE 3：onConflictDoNothing 吞掉的行**不**回报 → returning() 空 → 不记 added/π_i。
        .onConflictDoNothing()
        .returning({ id: practice_stream_item.id });
      // 行真被吞（并发/残留唯一索引冲突）→ inserted 为空 → 跳过 added + 观测（无幻影 π_i）。
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
        signals: (signal as unknown as Record<string, unknown>) ?? {},
      });
    }

    return { added, observations };
  });

  // 事务已提交——锁外 best-effort 写 π_i 观测（FINDING B：遥测失败不回滚重排）。
  await writeObservationsBestEffort(db, observations);
  return added;
}
