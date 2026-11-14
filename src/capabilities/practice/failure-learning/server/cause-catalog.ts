//B — 错因 catalog 扩张的复发信号 → LLM 提议生产者。
// 触发点：runAttributionAndWriteJudgeEvent 写出 primary='other' 的 judge 之后
// 内联调用（全吞错——目录扩张是机会型旁路，绝不影响归因 outcome）。
// 机制（ticket：attribution 落 other 时 tally，按 subject + 语义聚类粗略即可）：
// 1. pending 去重——同一 subject 同时最多一张 open catalog 提议，避免骚扰
// owner（accept/dismiss 后下一轮 other 才重新评估）。
// 2. tally——读侧聚合 getFailureAttemptsForDerivation 的 effective cause
// （user_cause 赢 judge；用途受限的失败本就不进模型输入），不建新表：
// event 流本身就是台账。
// 3. ≥ floor → CauseCategoryProposeTask 判定连贯模式 → propose event。
// LLM 只产语义（slug/label/description/rationale）；`ov_` 前缀与 id 防撞
// 在代码里收口。

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { pendingProposalWithCooldown } from '@/kernel/proposals/inbox';
import { learnerSummaryIfAllowed } from '@/kernel/proposals/learner-summary';
import {
  findActiveProposalCooldown,
  recordProposalProducerCooldown,
  withProposalGateLock,
} from '@/kernel/proposals/signals';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';
import { loadFailureLearningKnowledgeContext } from '@/kernel/read-models/failure-learning-context';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import {
  type CauseCategoryProposeInput,
  parseCauseCategoryProposeOutput,
} from '../tasks/cause-category-propose';
import { CAUSE_OVERLAY_ID_PREFIX, getCauseCategoryOverlaysByIds } from './cause-overlay';

/** other 复发触发提议的阈值（ticket「复发 ≥k」的 k——粗粒度，owner 仍会 vet）。 */
const OTHER_RECURRENCE_FLOOR = 3;
/** 读侧聚合窗口：最新 N 条失败尝试（n=1 数据量下即全量近因）。 */
const FAILURE_WINDOW = 200;
/** 喂给 LLM 的样本上限（newest-first 截取）。 */
const OTHER_SAMPLE_CAP = 8;
/** 单条 analysis 节选长度。 */
const ANALYSIS_EXCERPT_CAP = 300;
/** 弃权/撞名后与 dismiss 同长的冷却（复用 PROPOSAL_DISMISS_COOLDOWN_DAYS 语义）。 */
const PRODUCER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function causeCategoryCooldownKey(subjectId: string): string {
  return `cause_category:${subjectId}`;
}

function producerCooldownUntil(now = new Date()): Date {
  return new Date(now.getTime() + PRODUCER_COOLDOWN_MS);
}

/**
 * 最新已接受 cause_category rate 的水位。applier 在 rate payload 里写
 * `cooldown_key` + `other_watermark`；无 watermark 字段的老 rate 回退
 * rate.created_at（「接受时点」即分水岭）。只统计水位之后仍 effective='other'
 * 的新样本；已回标的事件本身不再 'other'，水位是双保险。
 */
async function latestAcceptWatermark(db: Db, cooldownKey: string): Promise<Date | null> {
  const rows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        sql`COALESCE(${event.payload}->>'rating','') = 'accept'`,
        sql`COALESCE(${event.payload}->>'cooldown_key','') = ${cooldownKey}`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const wm = (row.payload as { other_watermark?: unknown } | null)?.other_watermark;
  if (typeof wm === 'string') {
    const parsed = new Date(wm);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return row.created_at;
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
 *
 * YUK-2130 —— 三件事：
 * 1. 最新 accept 的 `other_watermark` 之后的 effective 'other' 才算复发——已回标
 *    的证据既不残留 'other'（supersede 改判），也不可能越过水位重复触发付费命名；
 * 2. LLM 弃权 / id 撞名写 proposal_signals.cooldown_until（生产者侧冷却，不动
 *    accept/dismiss 计数）——否则下一轮 other 又全额付费；
 * 3. write 前的 pending/cooldown 复查与 writeAiProposal 放进同一个
 *    `withProposalGateLock` 事务——两个并发 attribution 不会都通过 pre-check 各写
 *    一张提案（ticket 并发面）。
 */
export async function maybeProposeCauseCategoryFromOthers(params: {
  db: Db;
  /** effectiveProfile（声明 ∪ overlay.active）——负面清单 + subject id 来源。 */
  profile: SubjectProfile;
  runTaskFn: BoundRunTaskTextFn;
}): Promise<void> {
  try {
    const { db, profile } = params;
    const subjectId = profile.id;
    const cooldownKey = causeCategoryCooldownKey(subjectId);

    // pending 去重 + dismiss/生产者冷却——廉价的预检（写路径前还会在 gate lock
    // 内重查，见下）；任一命中即不再读失败窗/调 LLM。
    if (await pendingProposalWithCooldown(db, 'cause_category', cooldownKey)) return;
    if (await findActiveProposalCooldown(db, 'cause_category', [cooldownKey])) return;

    const watermark = await latestAcceptWatermark(db, cooldownKey);

    const failures = await getFailureAttemptsForDerivation(db, {
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
      // YUK-2130 —— 只统计最新 accept 水位之后的「新」other；已回标的事件不再
      // 是 'other'（supersede 后 effective 类目已换），水位兜底防漏。
      if (watermark !== null && effective.created_at.getTime() <= watermark.getTime()) {
        continue;
      }
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
    // 首个「存在」的 KC 决定归属（dangling [0] 不再把外科目失败劫持
    // 进 general 桶）；全部候选都不可解析 → 不进任何科目桶，单独记账，proposal
    // 落地时 reason_md 标注 bucket=unresolved。比归因链略严是有意的：归因给
    // 判不出科目的失败兜底 general 是运行语义，给词表扩张计数要更保守。
    const kcCandidatesOf = (c: (typeof otherCauses)[number]): string[] => {
      if (c.knowledgeIds.length > 0) return c.knowledgeIds;
      if (c.needsQuestionKcFallback) return questionKcById.get(c.questionId) ?? [];
      return [];
    };
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
    // 弃权（abstain）：模型判定这些样本不值得单独立类——和 dismiss 一样是终局
    // 意见，写生产者冷却，否则下一轮 other 会重新付费评同一批样本（YUK-2130）。
    if (output.action !== 'propose' || !output.slug || !output.label) {
      await recordProposalProducerCooldown(
        db,
        'cause_category',
        cooldownKey,
        producerCooldownUntil(),
      );
      return;
    }

    const categoryId = overlayCategoryId(output.slug);
    if (categoryId === CAUSE_OVERLAY_ID_PREFIX) {
      await recordProposalProducerCooldown(
        db,
        'cause_category',
        cooldownKey,
        producerCooldownUntil(),
      );
      return;
    }
    // 与生效词表（含 overlay.active）撞名 → 该类目已在词表里，无需再提议。撞名
    // 也是终局结论：换 slug 才会再来，同样写冷却（YUK-2130）。
    if (profile.causeCategories.some((category) => category.id === categoryId)) {
      await recordProposalProducerCooldown(
        db,
        'cause_category',
        cooldownKey,
        producerCooldownUntil(),
      );
      return;
    }
    // 与既有 overlay 行撞 id（draft/archived 也算）→ 不重复落行；owner 可对旧行
    // 人工恢复，而不是叠第二条。同写冷却。
    const existingRows = await getCauseCategoryOverlaysByIds(db, [categoryId]);
    if (existingRows.length > 0) {
      await recordProposalProducerCooldown(
        db,
        'cause_category',
        cooldownKey,
        producerCooldownUntil(),
      );
      return;
    }

    // Deterministic learner line; omitted (card uses the kind sentence) when the
    // model label would fail the same gate the writer applies.
    const learnerSummary = learnerSummaryIfAllowed(`新增错因分类「${output.label}」`);
    // 上面 `!output.label` 已早退；拷成局部常量把收窄带进下面的闭包。
    const proposedLabel = output.label as string;
    const proposedDescription = output.description;
    const proposedRationale = output.rationale_md;

    // 并发收口：LLM 调用是慢的付费步骤，放在锁外；写前在 gate lock 内重查
    // pending/cooldown——另一个 attribution 可能已经抢先写好提案或进入冷却。
    await withProposalGateLock(db, 'cause_category', [cooldownKey], async (tx) => {
      if (await pendingProposalWithCooldown(tx, 'cause_category', cooldownKey)) return;
      if (await findActiveProposalCooldown(tx, 'cause_category', [cooldownKey])) return;
      await writeAiProposal(tx, {
        actor_ref: 'attribution',
        payload: {
          kind: 'cause_category',
          target: { subject_kind: 'subject_profile', subject_id: subjectId },
          ...(learnerSummary !== undefined ? { learner_summary: learnerSummary } : {}),
          reason_md:
            (proposedRationale ??
              `${profile.displayName}里没能归到现有类别的错误反复出现了 ${scopedCauses.length} 次，看起来是同一种错因。`) +
            (unresolvedCount > 0
              ? `\n\n另有 ${unresolvedCount} 条错误找不到对应的知识点，没有算进这次判断。`
              : ''),
          // evidence_refs 标 event_role：effective event 对 user 源是
          // user_cause event、对 agent 源是 judge event，reviewer 不回查即分辨。
          evidence_refs: samples.map((sample) => ({
            kind: 'event' as const,
            id: sample.judge_event_id,
            event_role: sample.source === 'user' ? ('user_cause' as const) : ('judge' as const),
          })),
          cooldown_key: cooldownKey,
          proposed_change: {
            category_id: categoryId,
            label: proposedLabel,
            ...(proposedDescription ? { description: proposedDescription } : {}),
            source: 'llm_propose',
          },
        },
        caused_by_event_id: samples[0]?.judge_event_id ?? null,
        task_run_id: result.task_run_id ?? null,
        cost_usd: result.cost_usd ?? null,
      });
    });
  } catch (error) {
    // 机会型旁路：任何失败（DB/LLM/parse/dup）都不影响归因主流程。
    console.error('maybeProposeCauseCategoryFromOthers: skipped after error', error);
  }
}
