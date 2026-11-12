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
// 知识点（= 学了还没检验）。按置顶、截止、计划顺序取，先修未满足的不进池，各取一道未排入的题。
// - pendingPapers：getPracticeList 的 ready 且未开始 session 的卷。
// 减项 steering 的延后集合在 collectComposerInputs 开头读一次。到期（含干预
// 诊断）、变式、新学、前沿和待做卷：知识点全部落在该集合内才丢弃，混有集合外
// 知识点的综合题保留。

import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { LearningItemOpenStatus } from '@/core/schema/business';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { steeringDefersKnowledgeIds } from '@/core/steering';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import {
  artifact,
  learning_item,
  learning_session,
  material_fsrs_state,
  mistake_variant,
  question,
} from '@/db/schema';
import { errorResponse } from '@/kernel/http';
import { getCurrentFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { withoutNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import {
  type FrontierResolution,
  isMasteredForFrontier,
  learnableFrontierResolved,
} from '@/kernel/read-models/learnable-frontier';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { loadSteeringDeferredKnowledgeIds } from '@/kernel/read-models/steering-deferral';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import { getPracticeList } from '../../session/public';
import { REVIEW_DUE_LIMIT_MAX, type ReviewDueRow, queryReviewDue } from './due-list';
import { knowledgeLabels } from './knowledge-labels';
import { FRONTIER_MAX_ITEMS } from './learnable-frontier';
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
/** New-check pool handed to the sampler. Wider than a final pick of 3. */
const NEW_CHECK_CANDIDATE_LIMIT = 6;
/** A topic with no deadline sorts after every topic that has one. */
const NEW_CHECK_NO_DEADLINE_MS = Number.POSITIVE_INFINITY;
/** A topic missing from the hub step list sorts after every listed step. */
const NEW_CHECK_NO_PLAN_STEP = Number.POSITIVE_INFINITY;

/**
 * Lexicographic new-check key. Lower sorts first.
 * `prereqBlocked` 1 is not a candidate.
 * Plan order is acceptance time, then the hub step index, then the index inside that step.
 */
interface NewCheckRank {
  prereqBlocked: 0 | 1;
  unpinned: 0 | 1;
  dueAtMs: number;
  createdAtMs: number;
  planStep: number;
  withinStep: number;
  knowledgeId: string;
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNewCheckRank(left: NewCheckRank, right: NewCheckRank): number {
  return (
    compareNumber(left.prereqBlocked, right.prereqBlocked) ||
    compareNumber(left.unpinned, right.unpinned) ||
    compareNumber(left.dueAtMs, right.dueAtMs) ||
    compareNumber(left.createdAtMs, right.createdAtMs) ||
    compareNumber(left.planStep, right.planStep) ||
    compareNumber(left.withinStep, right.withinStep) ||
    compareText(left.knowledgeId, right.knowledgeId)
  );
}

function preferNewCheckRank(left: NewCheckRank, right: NewCheckRank): NewCheckRank {
  return compareNewCheckRank(left, right) <= 0 ? left : right;
}

function linkedArtifactIds(attrs: unknown): readonly string[] {
  if (typeof attrs !== 'object' || attrs === null || !('linked_artifact_ids' in attrs)) return [];
  const raw = attrs.linked_artifact_ids;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((id) => (typeof id === 'string' && id.length > 0 ? [id] : []));
}

function indexLinkedSteps(
  notes: ReadonlyArray<{ attrs: unknown }>,
  into: Map<string, number>,
): void {
  for (const note of notes) {
    const linked = linkedArtifactIds(note.attrs);
    for (let index = 0; index < linked.length; index += 1) {
      const artifactId = linked[index];
      if (artifactId === undefined) continue;
      const previous = into.get(artifactId);
      if (previous === undefined || index < previous) into.set(artifactId, index);
    }
  }
}

async function loadPlanSteps(
  db: DbLike,
  primaryArtifactIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(primaryArtifactIds)];
  if (ids.length === 0) return new Map();
  const notes = await db
    .select({
      id: artifact.id,
      parent_artifact_id: artifact.parent_artifact_id,
      attrs: artifact.attrs,
    })
    .from(artifact)
    .where(inArray(artifact.id, ids));
  const loaded = new Set(notes.map((note) => note.id));
  const parentIds = [
    ...new Set(
      notes.flatMap((note) =>
        note.parent_artifact_id !== null && !loaded.has(note.parent_artifact_id)
          ? [note.parent_artifact_id]
          : [],
      ),
    ),
  ];
  const parents =
    parentIds.length === 0
      ? []
      : await db
          .select({ attrs: artifact.attrs })
          .from(artifact)
          .where(inArray(artifact.id, parentIds));
  const steps = new Map<string, number>();
  indexLinkedSteps(notes, steps);
  indexLinkedSteps(parents, steps);
  return steps;
}

function rankOpenLearningTopics(
  items: ReadonlyArray<{
    knowledge_ids: readonly string[];
    user_pinned: boolean;
    due_at: Date | null;
    created_at: Date;
    primary_artifact_id: string | null;
  }>,
  planStepByArtifact: ReadonlyMap<string, number>,
): Map<string, NewCheckRank> {
  const priorityByKid = new Map<string, NewCheckRank>();
  for (const item of items) {
    const unpinned: 0 | 1 = item.user_pinned ? 0 : 1;
    const dueAtMs = item.due_at === null ? NEW_CHECK_NO_DEADLINE_MS : item.due_at.getTime();
    const planStep =
      item.primary_artifact_id === null
        ? NEW_CHECK_NO_PLAN_STEP
        : (planStepByArtifact.get(item.primary_artifact_id) ?? NEW_CHECK_NO_PLAN_STEP);
    let withinStep = 0;
    for (const raw of item.knowledge_ids) {
      const knowledgeId = raw.trim();
      if (knowledgeId.length === 0) continue;
      const occurrence: NewCheckRank = {
        prereqBlocked: 0,
        unpinned,
        dueAtMs,
        createdAtMs: item.created_at.getTime(),
        planStep,
        withinStep,
        knowledgeId,
      };
      withinStep += 1;
      const previous = priorityByKid.get(knowledgeId);
      priorityByKid.set(
        knowledgeId,
        previous === undefined ? occurrence : preferNewCheckRank(occurrence, previous),
      );
    }
  }
  return priorityByKid;
}

async function prereqBlockedByKnowledge(
  db: DbLike,
  knowledgeIds: readonly string[],
  resolution: FrontierResolution,
): Promise<Map<string, 0 | 1>> {
  // Overflow has no trustworthy closure, so every topic stays blocked.
  const proven = new Set(resolution.kind === 'dense' ? resolution.ids : []);
  const prereqsByKid = new Map<string, readonly string[] | null>();
  const toRead: string[] = [];
  for (const id of knowledgeIds) {
    if (resolution.kind === 'overflow') {
      prereqsByKid.set(id, null);
      continue;
    }
    if (proven.has(id)) {
      prereqsByKid.set(id, []);
      continue;
    }
    const prereqs =
      resolution.kind === 'dense' ? (resolution.prereqsByFrontier?.get(id) ?? []) : [];
    prereqsByKid.set(id, prereqs);
    toRead.push(...prereqs);
  }
  const projection = await getMasteryProjection(db, toRead);
  const mastered = (id: string): boolean => {
    const row = projection.get(id);
    // A missing row is the frontier cold start, below the mastery threshold.
    return row !== undefined && isMasteredForFrontier(row.mastery, row.evidence_count);
  };
  const blocked = new Map<string, 0 | 1>();
  for (const id of knowledgeIds) {
    const prereqs = prereqsByKid.get(id) ?? null;
    const unmet = prereqs === null || prereqs.some((prereqId) => !mastered(prereqId));
    blocked.set(id, unmet ? 1 : 0);
  }
  return blocked;
}

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

async function questionKnowledgeIds(
  db: DbLike,
  ids: readonly string[],
): Promise<Map<string, readonly string[]>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(inArray(question.id, unique));
  return new Map(rows.map((row) => [row.id, row.knowledge_ids]));
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

  const [dailyBudget, questionPace, deferredKnowledgeIds] = await Promise.all([
    resolveDailyPracticeBudget(db),
    readQuestionPace(db),
    loadSteeringDeferredKnowledgeIds(db, new Date()),
  ]);
  const steeringKeeps = (knowledgeIds: readonly string[]): boolean =>
    !steeringDefersKnowledgeIds(knowledgeIds, deferredKnowledgeIds);

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
  ].filter((row) => steeringKeeps(row.knowledge_ids ?? []));

  // 2. 错题变式 — active 变体，parent 近窗口内有 failure attempt。
  const since = new Date(Date.now() - VARIANT_WINDOW_DAYS * 24 * 3600 * 1000);
  const recentFailures = await getCurrentFailureAttempts(db, { since, limit: null });
  const failedQids = [...new Set(recentFailures.map((row) => row.question_id))];
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
  const variantKnowledgeIds =
    deferredKnowledgeIds.size === 0
      ? new Map<string, readonly string[]>()
      : await questionKnowledgeIds(db, [...admittedVariantIds]);
  const variantRows = variantCandidates
    .filter((row) => {
      const id = row.variant_question_id;
      return (
        id !== null &&
        admittedVariantIds.has(id) &&
        steeringKeeps(variantKnowledgeIds.get(id) ?? [])
      );
    })
    .slice(0, VARIANT_INPUT_LIMIT);

  // 3. 新学待检 — 尚未开始或正在学习的学习项，其知识点里没有 FSRS 状态行的。
  // 一份计划的各行共用同一个 created_at。跨行顺序是 hub 笔记
  // attrs.linked_artifact_ids（先 atomic 再 long）。不在名单里的没有步骤序。
  // 这些查询会跑在事务里，不能并行。
  const items = await db
    .select({
      knowledge_ids: learning_item.knowledge_ids,
      user_pinned: learning_item.user_pinned,
      due_at: learning_item.due_at,
      created_at: learning_item.created_at,
      primary_artifact_id: learning_item.primary_artifact_id,
    })
    .from(learning_item)
    .where(inArray(learning_item.status, LearningItemOpenStatus.options));
  const planSteps = await loadPlanSteps(
    db,
    items.flatMap((item) => item.primary_artifact_id ?? []),
  );
  const frontierResolution = await learnableFrontierResolved(db);
  const priorityByKid = rankOpenLearningTopics(items, planSteps);
  // YUK-1600 — the hub learning item references its topic ROOT (a goal); a goal is not
  // a testable KC and must never be picked as a new-check practice knowledge point.
  const candidateKids = await withoutNonKcKnowledgeIds(db, [...priorityByKid.keys()]);
  const newCheckPairs: Array<{ questionId: string; knowledgeId: string }> = [];
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
      const blockedByKid = await prereqBlockedByKnowledge(db, untracked, frontierResolution);
      const admitted = untracked.flatMap((knowledgeId) => {
        const base = priorityByKid.get(knowledgeId);
        if (base === undefined) return [];
        const rank: NewCheckRank = {
          ...base,
          prereqBlocked: blockedByKid.get(knowledgeId) ?? 1,
        };
        return rank.prereqBlocked === 0 ? [rank] : [];
      });
      admitted.sort(compareNewCheckRank);
      // 每个未检验知识点取一道题（JSONB 包含查询，非 draft 题——见 notDraftPredicate，src/db/predicates.ts）。
      // new_check 在「KC 还没 material_fsrs_state 行」时触发——此时刚生成的 embedded/teaching
      // draft 题（container-only）还没被任何 review 路径物化，若不过滤会被这里抓成第一题、暴露
      // 给用户成普通练习项。没有可发题的知识点不占候选名额。
      for (const rank of admitted) {
        if (newCheckPairs.length === NEW_CHECK_CANDIDATE_LIMIT) break;
        const candidates = await db
          .select({ id: question.id, knowledge_ids: question.knowledge_ids })
          .from(question)
          .where(
            and(
              sql`${question.knowledge_ids} @> ${JSON.stringify([rank.knowledgeId])}::jsonb`,
              notDraftPredicate(question.draft_status),
              // 契约准入门：suspended/withdrawn 组不作新检选第题。
              questionSuspendedPredicate(question),
            ),
          );
        const admittedIds = await readAutomaticallyServableQuestionIds(
          db,
          candidates.map((row) => row.id),
        );
        const q = candidates.find(
          (row) => admittedIds.has(row.id) && steeringKeeps(row.knowledge_ids),
        );
        if (q) newCheckPairs.push({ questionId: q.id, knowledgeId: rank.knowledgeId });
      }
    }
  }

  // 4. 当日待做卷 — ready 且未开始 session。
  const practiceList = await getPracticeList(db);
  const pendingPapers = practiceList.papers
    .filter(
      (p) =>
        p.generation_status === 'ready' && p.session === null && steeringKeeps(p.knowledge_ids),
    )
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
  // SKIP（不触发供给）。NO-OP：稀疏或闭包溢出时 ids 为空 → frontierPairs=[]（
  // defer-flip，无 flag；sparse/overflow 均保持空候选）。
  const frontierKcs = frontierResolution.ids;
  const frontierPairs: Array<{ questionId: string; knowledgeId: string }> = [];
  for (const kc of frontierKcs) {
    const candidates = await db
      .select({ id: question.id, knowledge_ids: question.knowledge_ids })
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
    const q = candidates.find((row) => admittedIds.has(row.id) && steeringKeeps(row.knowledge_ids));
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
