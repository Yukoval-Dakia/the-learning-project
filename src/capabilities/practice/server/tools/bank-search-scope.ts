import { type SQL, and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { item_calibration, knowledge, question, question_group_lifecycle } from '@/db/schema';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { canonicalKindToPersistedForms } from '@/subjects/question-kind';
import { resolveBankRefs } from './bank-ref';
import type { BankSearchScope } from './bank-search';

// Complete hard-scope responsibility: authorized ref/KC resolution and SQL
// predicates shared by recall and snapshot scope revalidation. No second codec.
interface ResolvedScope {
  scope: BankSearchScope;
  subjectKnowledgeIds?: string[];
  kindForms?: string[];
  withinRevisionIds?: string[];
  /** 去重后的 KC 硬过滤集（已验证全部为 live KC）。 */
  knowledgeFilterIds?: string[];
  /** KC 过滤语义：缺省 'any'。仅在 knowledgeFilterIds 存在时读。 */
  knowledgeFilterMode: 'any' | 'all';
  /** exclude_refs 解析出的 question 身份（group root id）集合。 */
  excludedQuestionIds?: string[];
  /** similar_to 锚的 question 身份（group root id）。 */
  similarToGroupId?: string;
}

export async function resolveBankSearchScope(
  db: Db | Tx,
  scope: BankSearchScope,
): Promise<ResolvedScope> {
  const resolved: ResolvedScope = { scope, knowledgeFilterMode: scope.knowledge_mode ?? 'any' };
  if (scope.subject !== undefined) {
    resolved.subjectKnowledgeIds = await resolveSubjectKnowledgeIds(db, scope.subject);
  }
  if (scope.kind !== undefined) {
    resolved.kindForms = canonicalKindToPersistedForms(scope.kind);
  }
  if (scope.within_refs !== undefined) {
    const refs = await resolveBankRefs(db, scope.within_refs);
    resolved.withinRevisionIds = refs.map((ref) => {
      if (ref.status !== 'ok') throw new Error(`within_refs: ${ref.raw}: ${ref.status}`);
      if (ref.lifecycle?.current_revision_id !== ref.revision.revision_id) {
        throw new Error(
          `within_refs: ${ref.raw}: superseded; search indexes only current revisions, read_bank can read this exact version`,
        );
      }
      return ref.revision.revision_id;
    });
  }
  if (scope.knowledge_ids !== undefined) {
    // 解析为真实科目 KC：去重后逐 id 校验 live（未归档）。未知/已归档 id 显式报错，
    // 绝不静默丢弃（静默丢弃 = 有效范围被窄化而调用方不知情）。
    const requested = [...new Set(scope.knowledge_ids)];
    const liveRows = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(inArray(knowledge.id, requested), isNull(knowledge.archived_at)));
    const live = new Set(liveRows.map((row) => row.id));
    const unknown = requested.filter((id) => !live.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `knowledge_ids: not live knowledge components (unknown or archived): ${unknown.join(', ')}`,
      );
    }
    resolved.knowledgeFilterIds = requested;
  }
  if (scope.exclude_refs !== undefined) {
    // 跨所有 revision 按 question 身份（revision.group_id = group root）排除。任意
    // revision 的 ref 都接受（superseded 也指向同一身份）；解不动/摘要不符显式报错
    // ——排除名单自身必须可信，否则「排除」变成静默放行。已撤回的组本就被
    // buildFilters 的 withdrawn 谓词挡在每种 admission_state 之外，跳过即等价排除，
    // 不让学习者已见列表里的一道撤回题拖垮整次检索。
    const refs = await resolveBankRefs(db, scope.exclude_refs);
    const ids = new Set<string>();
    for (const ref of refs) {
      if (ref.status === 'withdrawn') continue;
      if (ref.status !== 'ok') {
        throw new Error(`exclude_refs: ${ref.raw}: ${ref.status} (${ref.detail})`);
      }
      ids.add(ref.revision.group_id);
    }
    resolved.excludedQuestionIds = [...ids];
  }
  if (scope.similar_to !== undefined) {
    const [ref] = await resolveBankRefs(db, [scope.similar_to.question_ref]);
    if (ref == null) {
      throw new Error(`similar_to: ${scope.similar_to.question_ref}: unresolvable`);
    }
    if (ref.status !== 'ok') {
      throw new Error(
        `similar_to: ${scope.similar_to.question_ref}: ${ref.status} (${ref.detail})`,
      );
    }
    if (ref.lifecycle?.current_revision_id !== ref.revision.revision_id) {
      throw new Error(
        `similar_to: ${scope.similar_to.question_ref}: superseded; the stored content vector reflects the current revision — pass the current ref or read_bank the exact version`,
      );
    }
    resolved.similarToGroupId = ref.revision.group_id;
  }
  return resolved;
}

export function buildBankSearchFilters(resolved: ResolvedScope): SQL[] {
  const { scope } = resolved;
  const filters: SQL[] = [
    // 顶层行（组根本身）；part 行经组读取，不单独成候选。
    sql`(${question.parent_question_id} IS NULL)`,
    // 固定窗口诊断题不经题库面外泄。
    sql`(${question.source} <> ${INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE})`,
    // 死行与软删墓碑（listQuestions 同款标记族）。
    sql`((${question.metadata} -> 'dismissed_at') IS NULL)`,
    sql`((${question.metadata} -> 'archived_at') IS NULL)`,
  ];
  if (scope.draft_state === 'active') {
    filters.push(notDraftPredicate(question.draft_status));
  } else if (scope.draft_state === 'draft') {
    filters.push(eq(question.draft_status, 'draft'));
  }
  const lc = question_group_lifecycle;
  if (scope.admission_state === 'admitted') {
    filters.push(
      sql`(${lc.group_id} IS NOT NULL AND ${lc.scoring_admission_state} = 'admitted' AND ${lc.withdrawn} = false AND ${lc.suspended} = false)`,
    );
  } else if (scope.admission_state === 'withheld') {
    filters.push(
      sql`(${lc.group_id} IS NOT NULL AND ${lc.scoring_admission_state} = 'withheld' AND ${lc.withdrawn} = false)`,
    );
  } else {
    // 'any'：只排除已撤回（archive 已由 metadata 墓碑排除，此处兜底）。
    filters.push(sql`(${lc.withdrawn} IS NULL OR ${lc.withdrawn} = false)`);
  }
  if (resolved.subjectKnowledgeIds !== undefined) {
    if (resolved.subjectKnowledgeIds.length === 0) {
      filters.push(sql`false`);
    } else {
      const containers = resolved.subjectKnowledgeIds.map(
        (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
      );
      filters.push(sql`(${sql.join(containers, sql` OR `)})`);
    }
  }
  if (resolved.kindForms !== undefined) {
    if (resolved.kindForms.length === 0) {
      filters.push(sql`false`);
    } else {
      filters.push(
        sql`(${question.kind} IN (${sql.join(
          resolved.kindForms.map((f) => sql`${f}`),
          sql`, `,
        )}))`,
      );
    }
  }
  if (resolved.withinRevisionIds !== undefined) {
    filters.push(
      resolved.withinRevisionIds.length === 0
        ? sql`false`
        : inArray(lc.current_revision_id, resolved.withinRevisionIds),
    );
  }
  if (scope.source !== undefined) {
    filters.push(sql`(${question.source} = ${scope.source})`);
  }
  if (resolved.knowledgeFilterIds !== undefined) {
    // any = 题含任一 KC（逐 id 容器 OR）；all = 题含全部 KC（单容器包含检查）。
    if (resolved.knowledgeFilterIds.length === 0) {
      filters.push(sql`false`);
    } else if (resolved.knowledgeFilterMode === 'all') {
      filters.push(
        sql`(${question.knowledge_ids} @> ${JSON.stringify(resolved.knowledgeFilterIds)}::jsonb)`,
      );
    } else {
      const containers = resolved.knowledgeFilterIds.map(
        (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
      );
      filters.push(sql`(${sql.join(containers, sql` OR `)})`);
    }
  }
  if (scope.difficulty !== undefined) {
    const [lo, hi] = scope.difficulty.range;
    if (scope.difficulty.basis === 'authored') {
      // 作者难度 1–5 整数（NOT NULL）；闭区间。
      filters.push(sql`(${question.difficulty} BETWEEN ${lo} AND ${hi})`);
    } else {
      // 校准难度：item_calibration(track='hard') 的 effectiveB（logit 尺度）。
      // 无 row / effectiveB NULL（校准未知）的题被 EXISTS 天然排除——绝不退回作者难度。
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${item_calibration} ic WHERE ic.question_id = ${question.id} AND ic.track = 'hard' AND COALESCE(ic.b_post, ic.b_anchor, ic.b) BETWEEN ${lo} AND ${hi})`,
      );
    }
  }
  if (resolved.excludedQuestionIds !== undefined) {
    // 排除在通道层生效（不占召回配额）：被排除身份根本不进候选池。
    filters.push(
      resolved.excludedQuestionIds.length === 0
        ? sql`true`
        : sql`(${question.id} NOT IN (${sql.join(
            resolved.excludedQuestionIds.map((id) => sql`${id}`),
            sql`, `,
          )}))`,
    );
  }
  return filters;
}
