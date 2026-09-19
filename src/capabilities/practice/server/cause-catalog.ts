// YUK-1016 / 454-B — 错因 catalog 扩张的复发信号 → LLM 提议生产者。
//
// 触发点：runAttributionAndWriteJudgeEvent 写出 primary='other' 的 judge 之后
// 内联调用（全吞错——目录扩张是机会型旁路，绝不影响归因 outcome）。
//
// 机制（ticket：attribution 落 other 时 tally，按 subject + 语义聚类粗略即可）：
//   1. pending 去重——同一 subject 同时最多一张 open catalog 提议，避免骚扰
//      owner（accept/dismiss 后下一轮 other 才重新评估）。
//   2. tally——读侧聚合 getFailureAttempts 的 effective cause（user_cause 赢
//      judge），不建新表：event 流本身就是台账。
//   3. ≥ floor → CauseCategoryProposeTask 判定连贯模式 → propose event。
//      LLM 只产语义（slug/label/description/rationale）；`ov_` 前缀与 id 防撞
//      在代码里收口。

import { inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { pendingProposalWithCooldown } from '@/server/proposals/practice-runtime';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import {
  type CauseCategoryProposeInput,
  parseCauseCategoryProposeOutput,
} from '../tasks/cause-category-propose';
import { effectiveCauseForFailureAttempt, getFailureAttempts } from './attempt-events';
import { CAUSE_OVERLAY_ID_PREFIX, getCauseCategoryOverlaysByIds } from './cause-overlay';
import { loadFailureLearningKnowledgeContext } from './knowledge-runtime';
import type { PracticeTaskRunFn } from './task-runtime';

/** other 复发触发提议的阈值（ticket「复发 ≥k」的 k——粗粒度，owner 仍会 vet）。 */
const OTHER_RECURRENCE_FLOOR = 3;
/** 读侧聚合窗口：最新 N 条失败尝试（n=1 数据量下即全量近因）。 */
const FAILURE_WINDOW = 200;
/** 喂给 LLM 的样本上限（newest-first 截取）。 */
const OTHER_SAMPLE_CAP = 8;
/** 单条 analysis 节选长度。 */
const ANALYSIS_EXCERPT_CAP = 300;

function causeCategoryCooldownKey(subjectId: string): string {
  return `cause_category:${subjectId}`;
}

/** slug → CauseCategoryId 合法形：小写、非字母数字→下划线、去首尾下划线。 */
export function sanitizeOverlaySlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned;
}

export function overlayCategoryId(slug: string): string {
  return `${CAUSE_OVERLAY_ID_PREFIX}${sanitizeOverlaySlug(slug)}`;
}

/**
 * `other` 复发 → LLM 提议 → `cause_category` proposal event。
 *
 * 调用方必须把它当 fire-and-forget 旁路：本函数内部全部 try/catch，永不 throw
 * （归因 outcome 已定型，旁路失败只留 console.error）。
 */
export async function maybeProposeCauseCategoryFromOthers(params: {
  db: Db;
  /** effectiveProfile（声明 ∪ overlay.active）——负面清单 + subject id 来源。 */
  profile: SubjectProfile;
  runTaskFn: PracticeTaskRunFn;
}): Promise<void> {
  try {
    const { db, profile } = params;
    const subjectId = profile.id;
    const cooldownKey = causeCategoryCooldownKey(subjectId);

    // pending 去重：一张 open 提议没裁决前不再造第二张。
    if (await pendingProposalWithCooldown(db, 'cause_category', cooldownKey)) return;

    const failures = await getFailureAttempts(db, {
      limit: FAILURE_WINDOW,
      includeReviewFailures: true,
    });
    const candidates: Array<{
      judge_event_id: string;
      analysis_md: string;
      created_at: Date;
      source: 'user' | 'agent';
      /** attribution 同款 subject 解析输入：referenced kc ids + fallback 标记。 */
      knowledgeIds: string[];
      questionId: string;
      needsQuestionKcFallback: boolean;
    }> = [];
    for (const failure of failures) {
      const effective = effectiveCauseForFailureAttempt(failure);
      if (effective?.primary_category !== 'other') continue;
      const text = effective.analysis_md ?? effective.user_notes ?? '';
      candidates.push({
        judge_event_id: effective.event_id,
        analysis_md: text.slice(0, ANALYSIS_EXCERPT_CAP),
        created_at: effective.created_at,
        source: effective.source,
        knowledgeIds: failure.referenced_knowledge_ids,
        questionId: failure.question_id,
        needsQuestionKcFallback:
          failure.referenced_knowledge_ids.length === 0 && failure.question_snapshot === undefined,
      });
    }
    // 占位 judge（payload.attribution_pending=true，paper/review 提交时的「归因
    // 待跑」标记，review 路占位还是永久的）不算真 other——否则 floor 极易被占位
    // 行凑满，每次真 other 都触发 LLM。FailureAttemptJudge 契约不投影该 flag，
    // 按 effective event_id 批量回查 payload（lost-attribution-backfill 同款）。
    const agentEventIds = candidates
      .filter((c) => c.source === 'agent')
      .map((c) => c.judge_event_id);
    const pendingIds = new Set(
      agentEventIds.length === 0
        ? []
        : (
            await db
              .select({ id: event.id, payload: event.payload })
              .from(event)
              .where(inArray(event.id, agentEventIds))
          )
            .filter(
              (row) =>
                (row.payload as { attribution_pending?: boolean }).attribution_pending === true,
            )
            .map((row) => row.id),
    );
    const otherCauses = candidates.filter(
      (c) => c.source === 'user' || !pendingIds.has(c.judge_event_id),
    );

    // 按 subject 收敛（ticket「按 subject + 语义聚类粗略即可」）：question 无
    // subject 列，attempt 的 subject 走 attribution 同款解析链——
    // referenced_knowledge_ids[0]（空则 live question 的 knowledge_ids[0]，frozen
    // snapshot 则空）→ effective_domain → resolveSubjectProfile(domain).id。
    // 跨科目 'other' 不得替本科目凑 floor，更不能带着本科目名进 LLM prompt。
    const needQuestionKc = otherCauses
      .filter((c) => c.needsQuestionKcFallback)
      .map((c) => c.questionId);
    const questionKcById = new Map<string, string[]>();
    if (needQuestionKc.length > 0) {
      const rows = await db
        .select({ id: question.id, knowledge_ids: question.knowledge_ids })
        .from(question)
        .where(inArray(question.id, [...new Set(needQuestionKc)]));
      for (const row of rows) questionKcById.set(row.id, row.knowledge_ids);
    }
    // YUK-1019 — 首个「存在」的 KC 决定归属（dangling [0] 不再把外科目失败劫持
    // 进 general 桶）；全部候选都不可解析 → 不进任何科目桶，单独记账，proposal
    // 落地时 reason_md 标注 bucket=unresolved。比归因链略严是有意的：归因给
    // 判不出科目的失败兜底 general 是运行语义，给词表扩张计数要更保守。
    const kcCandidatesOf = (c: (typeof otherCauses)[number]): string[] =>
      c.knowledgeIds.length > 0
        ? c.knowledgeIds
        : c.needsQuestionKcFallback
          ? (questionKcById.get(c.questionId) ?? [])
          : [];
    const kcNodes = await loadFailureLearningKnowledgeContext(db, [
      ...new Set(otherCauses.flatMap(kcCandidatesOf)),
    ]);
    const domainByKc = new Map(kcNodes.map((node) => [node.id, node.effective_domain]));
    const scopedCauses: typeof otherCauses = [];
    let unresolvedCount = 0;
    for (const c of otherCauses) {
      const kcId = kcCandidatesOf(c).find((id) => domainByKc.has(id));
      if (kcId === undefined) {
        unresolvedCount += 1;
        continue;
      }
      if (resolveSubjectProfile(domainByKc.get(kcId) ?? null).id === subjectId) {
        scopedCauses.push(c);
      }
    }
    if (scopedCauses.length < OTHER_RECURRENCE_FLOOR) return;

    const samples = scopedCauses
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, OTHER_SAMPLE_CAP);

    const input: CauseCategoryProposeInput = {
      subject_display_name: profile.displayName,
      existing_categories: profile.causeCategories.map((category) => ({
        id: category.id,
        label: category.label,
      })),
      other_samples: samples.map((sample) => ({ analysis_md: sample.analysis_md })),
      recurrence_count: scopedCauses.length,
    };
    const result = await params.runTaskFn('CauseCategoryProposeTask', input, {
      subjectProfile: profile,
    });
    const output = parseCauseCategoryProposeOutput(result.text);
    if (output.action !== 'propose' || !output.slug || !output.label) return;

    const categoryId = overlayCategoryId(output.slug);
    if (categoryId === CAUSE_OVERLAY_ID_PREFIX) return;
    // 与生效词表（含 overlay.active）撞名 → 该类目已在词表里，无需再提议。
    if (profile.causeCategories.some((category) => category.id === categoryId)) return;
    // 与既有 overlay 行撞 id（draft/archived 也算）→ 不重复落行；owner 可对旧行
    // 人工恢复，而不是叠第二条。
    const existingRows = await getCauseCategoryOverlaysByIds(db, [categoryId]);
    if (existingRows.length > 0) return;

    await writeAiProposal(db, {
      actor_ref: 'attribution',
      payload: {
        kind: 'cause_category',
        target: { subject_kind: 'subject_profile', subject_id: subjectId },
        reason_md:
          (output.rationale_md ??
            `${subjectId} 的 other 归因复发 ${scopedCauses.length} 次，LLM 判定存在连贯错因模式。`) +
          (unresolvedCount > 0
            ? `\n\n另有 ${unresolvedCount} 条 other 失败因 KC 不可解析未计入本桶（bucket=unresolved）。`
            : ''),
        // YUK-1019 — evidence_refs 标 event_role：effective event 对 user 源是
        // user_cause event、对 agent 源是 judge event，reviewer 不回查即分辨。
        evidence_refs: samples.map((sample) => ({
          kind: 'event' as const,
          id: sample.judge_event_id,
          event_role: sample.source === 'user' ? ('user_cause' as const) : ('judge' as const),
        })),
        cooldown_key: cooldownKey,
        proposed_change: {
          category_id: categoryId,
          label: output.label,
          ...(output.description ? { description: output.description } : {}),
          source: 'llm_propose',
        },
      },
      caused_by_event_id: samples[0]?.judge_event_id ?? null,
      task_run_id: result.task_run_id ?? null,
      cost_usd: result.cost_usd ?? null,
    });
  } catch (error) {
    // 机会型旁路：任何失败（DB/LLM/parse/dup）都不影响归因主流程。
    console.error('maybeProposeCauseCategoryFromOthers: skipped after error', error);
  }
}
