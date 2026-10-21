// 练习流「候选输入收集」职责模块（自 stream-store.ts 拆出）。
// 把 FSRS 到期投影（含干预诊断并集）、错题变式、新学待检、当日待做卷、learnable
// frontier 与日练习预算收拢成一次 collectComposerInputs —— lazy compose / nightly
// 预产 / recompose / 作答后增量重排共用的候选池与信号来源。物化、锁与流推进编排
// 留在 stream-store.ts；纯函数合流核心在 stream-composer.ts；本模块只做候选收集
// 与查询组合。
// 输入信号来源（P2 「due-list 降级为输入信号」）：
// - dueItems：与 HTTP adapter 共用的 typed due 读取 queryReviewDue——FSRS 到期
// 投影 + 跨学科 round-robin + goal 软偏置全部复用现行为；读取失败按既有
// 契约降级为空候选（见 readComposerDueRows）。旧 /api/review/due 不删。
// - variantItems：mistake_variant(status='active') 中 parent 近 7 天有 failure
// attempt 的变体（变体轮换的「错题跟练」信号）。
// - newCheckItems：open learning_item（pending/in_progress）的 knowledge_ids 中尚无 FSRS 状态行的
// 知识点（= 学了还没检验），各取一道未排入的题。
// - pendingPapers：getPracticeList 的 ready 且未开始 session 的卷。

import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { LearningItemOpenStatus } from '@/core/schema/business';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import {
  event,
  learning_item,
  learning_session,
  material_fsrs_state,
  mistake_variant,
  question,
} from '@/db/schema';
import { errorResponse } from '@/kernel/http';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import { REVIEW_DUE_LIMIT_MAX, type ReviewDueRow, queryReviewDue } from './due-list';
import { knowledgeLabels } from './knowledge-labels';
import { FRONTIER_MAX_ITEMS, learnableFrontier } from './learnable-frontier';
import { getPracticeList } from './practice-read';
import { readQuestionPace } from './question-pace';
import {
  type DailyPracticePace,
  dailyPracticeBudgetMinutes,
  normalizeDailyPracticePace,
} from './stream-budget';
import type { ComposerInputs } from './stream-composer';

// knowledgeLabels 事实读取已归 ./knowledge-labels；此 reexport 保持
// 本模块既有导出面不变（旧 import 路径兼容）。
export { knowledgeLabels } from './knowledge-labels';

/** 本模块的 DB 句柄：既可是顶层 `db`，也可是事务内 `tx`。 */
type DbLike = Db | Tx;

const VARIANT_WINDOW_DAYS = 7;
/** Hard ceiling for mistake variants admitted to one composer/LLM input. */
export const VARIANT_INPUT_LIMIT = 50;

export async function resolveDailyPracticeBudget(
  db: DbLike,
): Promise<{ pace: DailyPracticePace; minutes: number }> {
  const [latest] = await db
    .select({ pace: learning_session.placement_pace })
    .from(learning_session)
    .where(and(eq(learning_session.type, 'placement'), isNotNull(learning_session.placement_pace)))
    .orderBy(desc(learning_session.created_at), desc(learning_session.id))
    .limit(1);
  const pace = normalizeDailyPracticePace(latest?.pace);
  return { pace, minutes: dailyPracticeBudgetMinutes(pace) };
}

interface QuestionMixMetadata {
  knowledgeId?: string;
  questionKind?: string;
  isInterventionDiagnostic?: boolean;
}

async function questionMixMetadata(
  db: DbLike,
  ids: string[],
): Promise<Map<string, QuestionMixMetadata>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: question.id,
      knowledge_ids: question.knowledge_ids,
      kind: question.kind,
      source: question.source,
    })
    .from(question)
    .where(inArray(question.id, unique));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        knowledgeId: row.knowledge_ids[0],
        questionKind: row.kind,
        isInterventionDiagnostic: row.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
      } satisfies QuestionMixMetadata,
    ]),
  );
}

/**
 * composer 的 due 页读取与降级边界。直调 HTTP adapter 共用的
 * `queryReviewDue`，请求 due 页 FULL ceiling（REVIEW_DUE_LIMIT_MAX——与 adapter
 * 同一 clamp 事实； H8：merge engine 可重排/降权但不得丢 due）。
 * due 读取失败经 canonical `errorResponse` 整形/记日志（Response 丢弃）后降级
 * 为 []，与旧 `rows ?? []` 等价；`errorResponse` 自身失败（如 ApiError details
 * 不可序列化）照旧向外抛。本函数之后的所有查询（intervention 并集、变式、
 * new_check…）仍抛出——降级只覆盖 due 页读取这一步。
 */
async function readComposerDueRows(db: DbLike): Promise<ReviewDueRow[]> {
  try {
    const { rows } = await queryReviewDue(db, { limit: REVIEW_DUE_LIMIT_MAX });
    return rows;
  } catch (err) {
    errorResponse(err);
    return [];
  }
}

export async function collectComposerInputs(db: DbLike, date: string): Promise<ComposerInputs> {
  // 红线 4（draft 排除契约，）：通用练习池的选题候选**必须排除** draft_status='draft'
  // （NULL≡active / 'active' 留池，仅排字面 'draft'）。new_check + frontier 共用
  // notDraftPredicate（@/db/predicates，三值逻辑安全的单一定义）。

  const [dailyBudget, questionPace] = await Promise.all([
    resolveDailyPracticeBudget(db),
    readQuestionPace(db),
  ]);

  // 1. FSRS 到期投影 — 与 HTTP adapter 共用的 typed due 读取。
  const cappedDueRows = await readComposerDueRows(db);

  // intervention diagnostics are an approved learner delivery, not an
  // optional member of the generic due page. The due page is capped at
  // REVIEW_DUE_LIMIT_MAX (200), so a diagnostic can otherwise disappear behind
  // an older ordinary backlog before the composer ever sees (and protects) its
  // `intervention` source. Read the due intervention subset independently, then
  // prefix-union it with the capped page. The FSRS row is the
  // activation/scheduling boundary; draft follow-ups without a row remain
  // invisible.
  const interventionCandidates = await db
    .select({
      question_id: question.id,
      knowledge_ids: question.knowledge_ids,
    })
    .from(material_fsrs_state)
    .innerJoin(question, eq(question.id, material_fsrs_state.subject_id))
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'question'),
        lte(material_fsrs_state.due_at, new Date()),
        eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
        notDraftPredicate(question.draft_status),
      ),
    )
    .orderBy(material_fsrs_state.due_at, question.created_at, question.id);
  const admittedInterventionIds = await readAutomaticallyServableQuestionIds(
    db,
    interventionCandidates.map((row) => row.question_id),
    { includeInterventionDiagnostics: true },
  );
  const protectedInterventionRows = interventionCandidates.filter((row) =>
    admittedInterventionIds.has(row.question_id),
  );
  const protectedInterventionIds = new Set(protectedInterventionRows.map((row) => row.question_id));
  const dueRows = [
    ...protectedInterventionRows,
    ...cappedDueRows.filter((row) => !protectedInterventionIds.has(row.question_id)),
  ];

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
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const failedQids = [...new Set(recentFailures.map((r) => r.qid))];
  const variantCandidates =
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
          )
          .orderBy(desc(mistake_variant.created_at), desc(mistake_variant.id));
  const admittedVariantIds = await readAutomaticallyServableQuestionIds(
    db,
    variantCandidates.flatMap((row) => row.variant_question_id ?? []),
  );
  const variantRows = variantCandidates
    .filter(
      (row) => row.variant_question_id !== null && admittedVariantIds.has(row.variant_question_id),
    )
    .slice(0, VARIANT_INPUT_LIMIT);

  // 3. 新学待检 — 尚未开始或正在学习的学习项，其知识点里没有 FSRS 状态行的。
  const items = await db
    .select({ knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(inArray(learning_item.status, LearningItemOpenStatus.options));
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
      // 每个未检验知识点取一道题（JSONB 包含查询，非 draft 题——见 notDraftPredicate，src/db/predicates.ts）。
      // new_check 在「KC 还没 material_fsrs_state 行」时触发——此时刚生成的 embedded/teaching
      // draft 题（container-only）还没被任何 review 路径物化，若不过滤会被这里抓成第一题、暴露
      // 给用户成普通练习项。
      for (const kid of untracked) {
        const candidates = await db
          .select({ id: question.id })
          .from(question)
          .where(
            and(
              sql`${question.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`,
              notDraftPredicate(question.draft_status),
              // 契约准入门：suspended/withdrawn 组不作新检选第题。
              questionSuspendedPredicate(question),
            ),
          );
        const admittedIds = await readAutomaticallyServableQuestionIds(
          db,
          candidates.map((row) => row.id),
        );
        const q = candidates.find((row) => admittedIds.has(row.id));
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

  // 5. B3 learnable_frontier（#3）——前置全掌握、自身未掌握的「可学前沿」KC，各取
  // 一道**非 draft** active 题（谓词与 new_check 同形，均 notDraftPredicate——红线 4）。frontier KC 无题 →
  // SKIP（不触发供给）。NO-OP：稀疏先决图上 learnableFrontier 返 [] → frontierPairs=[]（
  // defer-flip，无 flag——见 learnable-frontier.ts 不变量块）。
  const frontierKcs = await learnableFrontier(db);
  const frontierPairs: Array<{ questionId: string; knowledgeId: string }> = [];
  for (const kc of frontierKcs) {
    const candidates = await db
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          sql`${question.knowledge_ids} @> ${JSON.stringify([kc])}::jsonb`,
          notDraftPredicate(question.draft_status),
          // 契约准入门：suspended/withdrawn 组不进 frontier 选题。
          questionSuspendedPredicate(question),
        ),
      )
      // Deterministic pick (reproducible composition) — the new_check sibling omits this;
      // frontier is net-new so we make it stable from the start.
      .orderBy(question.id);
    const admittedIds = await readAutomaticallyServableQuestionIds(
      db,
      candidates.map((row) => row.id),
    );
    const q = candidates.find((row) => admittedIds.has(row.id));
    if (q) frontierPairs.push({ questionId: q.id, knowledgeId: kc });
    if (frontierPairs.length === FRONTIER_MAX_ITEMS) break;
  }

  // L3 fatigue/repetition needs stable KC + question-kind identities. Resolve every
  // question in one bounded batch; the post-filter remains pure and never performs IO itself.
  const mixMetadataByQuestion = await questionMixMetadata(db, [
    ...dueRows.map((row) => row.question_id),
    ...variantRows.flatMap((row) => row.variant_question_id ?? []),
    ...newCheckPairs.map((pair) => pair.questionId),
    ...frontierPairs.map((pair) => pair.questionId),
  ]);

  // 标签批量解析（reasoning 模板用）。
  const labelMap = await knowledgeLabels(db, [
    ...dueRows.flatMap((r) => r.knowledge_ids ?? []).slice(0, 50),
    ...newCheckPairs.map((p) => p.knowledgeId),
    ...frontierPairs.map((p) => p.knowledgeId),
  ]);

  return {
    date,
    dailyBudgetMinutes: dailyBudget.minutes,
    questionMinutes: questionPace.minutes,
    dueItems: dueRows.map((r) => {
      const metadata = mixMetadataByQuestion.get(r.question_id);
      return {
        questionId: r.question_id,
        knowledgeLabel: r.knowledge_ids?.length ? labelMap.get(r.knowledge_ids[0]) : undefined,
        knowledgeId: metadata?.knowledgeId,
        questionKind: metadata?.questionKind,
        source: metadata?.isInterventionDiagnostic ? 'intervention' : 'decay',
      };
    }),
    variantItems: variantRows
      .filter((v): v is { variant_question_id: string; parent_question_id: string } =>
        Boolean(v.variant_question_id),
      )
      .map((v) => ({
        questionId: v.variant_question_id,
        rootQuestionId: v.parent_question_id,
        ...mixMetadataByQuestion.get(v.variant_question_id),
      })),
    newCheckItems: newCheckPairs.map((p) => ({
      questionId: p.questionId,
      knowledgeId: p.knowledgeId,
      knowledgeLabel: labelMap.get(p.knowledgeId),
      questionKind: mixMetadataByQuestion.get(p.questionId)?.questionKind,
    })),
    pendingPapers,
    frontierItems: frontierPairs.map((p) => ({
      questionId: p.questionId,
      knowledgeId: p.knowledgeId,
      knowledgeLabel: labelMap.get(p.knowledgeId),
      questionKind: mixMetadataByQuestion.get(p.questionId)?.questionKind,
    })),
  };
}
