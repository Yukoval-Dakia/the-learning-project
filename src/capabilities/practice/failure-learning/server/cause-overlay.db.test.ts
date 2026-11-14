// YUK-1016 / 454-B — cause_category_overlay DB 测试。
// 覆盖：reader 过滤语义（active-only / subject-scope / 序）、proposal→accept→row、
// idempotent accept、retract→archived、attribution 合并读取（ov_ 进候选 + 校验
// 不 clamp）、variant targetable、other tally→propose 全链。
// YUK-2130 —— accept 回标证据 + 决策水位 + 弃权/撞名冷却。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, knowledge, proposal_signals, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { classifyAutoAppliedUndoBatch } from '@/kernel/proposals/auto-applied-undo';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';
import { acceptAiProposal } from '@/server/proposals/actions';
import { retractAiProposal } from '@/server/proposals/retract-action';
import { installProposalUndoGuards } from '@/server/proposals/undo-guards';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { maybeProposeCauseCategoryFromOthers } from './cause-catalog';
import { getCauseCategoryOverlaysByIds } from './cause-overlay';

async function writeCauseCategoryProposal(opts: {
  categoryId: string;
  label?: string;
  source?: 'owner' | 'llm_propose';
  subjectId?: string;
  cooldownKey?: string;
}) {
  const db = testDb();
  return writeAiProposal(db, {
    actor_ref: 'dreaming',
    payload: {
      kind: 'cause_category',
      target: {
        subject_kind: 'subject_profile',
        subject_id: opts.subjectId ?? 'general',
      },
      reason_md: '测试提议',
      evidence_refs: [{ kind: 'event', id: 'evt_seed_1' }],
      cooldown_key: opts.cooldownKey ?? `cause_category:${opts.subjectId ?? 'general'}`,
      proposed_change: {
        category_id: opts.categoryId,
        label: opts.label ?? '测试类目',
        description: '说明文字',
        source: opts.source ?? 'llm_propose',
      },
    },
  });
}

describe('cause_category proposal → accept → overlay row', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('re-accept is idempotent (one row, one rate event)', async () => {
    const proposalId = await writeCauseCategoryProposal({ categoryId: 'ov_idem' });
    await acceptAiProposal(testDb(), proposalId);
    const second = await acceptAiProposal(testDb(), proposalId);
    expect(second.idempotent).toBe(true);

    const rows = await getCauseCategoryOverlaysByIds(testDb(), ['ov_idem']);
    expect(rows).toHaveLength(1);
  });

  it('concurrent accepts of the same category_id: exactly one wins, loser gets 409', async () => {
    // 两张 pending proposal 指同一 categoryId、并发 accept——decision lock 按
    // proposalId 取不互斥，onConflictDoNothing 兜底保证输家是 409 而非裸 PK 500。
    const proposalA = await writeCauseCategoryProposal({
      categoryId: 'ov_race',
      subjectId: 'general',
    });
    const proposalB = await writeCauseCategoryProposal({
      categoryId: 'ov_race',
      subjectId: 'math',
      cooldownKey: 'cause_category:math',
    });
    const [a, b] = await Promise.allSettled([
      acceptAiProposal(testDb(), proposalA),
      acceptAiProposal(testDb(), proposalB),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((r) => r.status === 'rejected');
    expect(loser?.status).toBe('rejected');
    if (loser?.status === 'rejected') {
      expect(loser.reason).toBeInstanceOf(ApiError);
      expect((loser.reason as ApiError).status).toBe(409);
    }

    const rows = await getCauseCategoryOverlaysByIds(testDb(), ['ov_race']);
    expect(rows).toHaveLength(1);
  });
});

// ─── YUK-2130 —— accept 时回标 'other' 证据 + 决策水位 + 生产者冷却 ───

const SUBJECT_DOMAIN = 'yuwen';
const KC_ID = 'kc_cause_relabel';
const QUESTION_ID = 'q_cause_relabel';

async function seedCauseRelabelFixture(): Promise<void> {
  const now = new Date('2026-08-10T00:00:00.000Z');
  await testDb().insert(knowledge).values({
    id: KC_ID,
    name: '回标知识点',
    domain: SUBJECT_DOMAIN,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await testDb()
    .insert(question)
    .values({
      id: QUESTION_ID,
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: 'r',
      source: 'manual',
      knowledge_ids: [KC_ID],
      created_at: now,
      updated_at: now,
    });
}

/** 写一条真实链 attempt → judge('other')，返回 attempt/judge id。 */
async function seedOtherJudgedFailure(
  attemptId: string,
  judgeId: string,
  createdAt: Date,
): Promise<void> {
  await writeEvent(testDb(), {
    id: attemptId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: QUESTION_ID,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [KC_ID],
    },
    created_at: createdAt,
  });
  await writeEvent(testDb(), {
    id: judgeId,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '归不进现有类目',
        confidence: 0.7,
      },
      referenced_knowledge_ids: [KC_ID],
    },
    caused_by_event_id: attemptId,
    created_at: new Date(createdAt.getTime() + 60_000),
  });
}

async function proposalWithEvidence(categoryId: string, evidenceEventIds: string[]) {
  return writeAiProposal(testDb(), {
    actor_ref: 'attribution',
    payload: {
      kind: 'cause_category',
      target: { subject_kind: 'subject_profile', subject_id: SUBJECT_DOMAIN },
      reason_md: '复发 other',
      evidence_refs: evidenceEventIds.map((id) => ({ kind: 'event' as const, id })),
      cooldown_key: `cause_category:${SUBJECT_DOMAIN}`,
      proposed_change: {
        category_id: categoryId,
        label: '回标类目',
        source: 'llm_propose',
      },
    },
  });
}

async function effectiveCategories(): Promise<Map<string, string | null>> {
  const failures = await getFailureAttemptsForDerivation(testDb(), {
    includeReviewFailures: true,
    limit: null,
  });
  return new Map(
    failures.map((failure) => [
      failure.attempt_event_id,
      effectiveCauseForFailureAttempt(failure)?.primary_category ?? null,
    ]),
  );
}

describe('YUK-2130 accept → canonical relabel + decision watermark', () => {
  beforeEach(async () => {
    await resetDb();
    await seedCauseRelabelFixture();
  });

  // @invariant grading: accepting a cause-category proposal rewrites exactly the evidence rows'
  //   effective categories through the canonical supersede path — mistakes read shows the new
  //   category, raw judge rows stay append-only — and the accept watermark fences off every
  //   pre-accept 'other' so the producer cannot re-pay a naming pass on evidence it just acted on.
  // @fails-if accept skips the supersede (raw row mutated or effective read unchanged), unlisted
  //   'other' rows are relabelled, or pre-accept 'other' rows still count toward the recurrence
  //   floor and re-invoke the paid task.
  it('accept relabels its evidence via supersede; post-accept tally excludes pre-accept others', async () => {
    // 3 条 evidence 'other'（T0=9:0x，触发提案那批）+ 2 条不在 evidence_refs 的
    // 'other'，落在 T0 与 accept(T3=now) 之间的 T1/T2（11:0x）。这正是决策水位
    // 与「样本最晚水位」的分界线：水位取错时 T1/T2 越界，与 accept 后那条新
    // other 一起凑满 floor=3 → producer 再调 LLM；水位正确则 tally=1，未到
    // floor 直接返回。测试不靠 runTaskFn 抛错（旁路 catch 会吞掉）——用弃权
    // stub 让 producer 走到「写冷却」的真实落库分支，再断言 proposal_signals
    // 没有 cooldown 行：水位漏 → 任务跑 → abstain → 冷却落库 → 断言失败。
    for (const index of [0, 1, 2]) {
      await seedOtherJudgedFailure(
        `att_evidence_${index}`,
        `judge_evidence_${index}`,
        new Date(Date.UTC(2026, 7, 10, 9, index)),
      );
    }
    for (const index of [0, 1]) {
      await seedOtherJudgedFailure(
        `att_unlisted_${index}`,
        `judge_unlisted_${index}`,
        new Date(Date.UTC(2026, 7, 10, 11, index)),
      );
    }

    const proposalId = await proposalWithEvidence('ov_relabelled', [
      'judge_evidence_0',
      'judge_evidence_1',
      'judge_evidence_2',
    ]);
    const accepted = await acceptAiProposal(testDb(), proposalId);
    expect(accepted.lifecycle_outcome ?? 'accepted').toBe('accepted');

    const categories = await effectiveCategories();
    expect(categories.get('att_evidence_0')).toBe('ov_relabelled');
    expect(categories.get('att_evidence_1')).toBe('ov_relabelled');
    expect(categories.get('att_evidence_2')).toBe('ov_relabelled');
    // 未列在证据里的旧 'other' 不动（保留原判；靠 accept 水位挡回 tally）。
    expect(categories.get('att_unlisted_0')).toBe('other');
    expect(categories.get('att_unlisted_1')).toBe('other');

    // 原判保留 superseded 链：raw judge 行还在，但 effective 已替换。
    const [replaced] = await testDb()
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.id, 'judge_evidence_0'));
    expect(
      (replaced?.payload as { cause?: { primary_category?: string } } | undefined)?.cause
        ?.primary_category,
    ).toBe('other');

    // accept 水位之后来一条真 'other'：tally 只该见到它（1 < floor=3），
    // producer 未到付费任务就返回，signals 里没有冷却行。水位若漏，2 条
    // unlisted T1/T2 旧 other 会让 tally=3 → runTaskFn 被调 → abstain →
    // cooldown_until 落库 → 断言失败。
    await seedOtherJudgedFailure('att_post', 'judge_post', new Date());
    const { resolveSubjectProfile } = await import('@/subjects/profile');
    // Abstaining model: producer reaches its "paid step ran, decided not to
    // propose" branch and persists a durable cooldown row — observable business
    // state, not a mock interaction.
    const abstainTask = async () => ({
      text: JSON.stringify({ action: 'abstain' }),
      task_run_id: 'tr_abstain',
      cost_usd: 0.001,
    });
    await maybeProposeCauseCategoryFromOthers({
      db: testDb(),
      profile: resolveSubjectProfile(SUBJECT_DOMAIN),
      runTaskFn: abstainTask,
    });
    const cooldownRows = await testDb()
      .select({ cooldown_until: proposal_signals.cooldown_until })
      .from(proposal_signals)
      .where(eq(proposal_signals.cooldown_key, `cause_category:${SUBJECT_DOMAIN}`));
    // No paid naming pass ran on pre-accept evidence: no producer cooldown written.
    expect(cooldownRows[0]?.cooldown_until ?? null).toBeNull();

    // Undo must restore only this accept's still-effective effect. A learner
    // mark_wrong/retract on a superseded original (T2, after accept T1) is the
    // current correction truth — undo archives the category but leaves that
    // correction effective; restoring over it would erase the learner's call.
    installProposalUndoGuards();
    await writeEvent(testDb(), {
      id: `autoapply_${proposalId}`,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'experimental:auto_apply',
      subject_kind: 'subject_profile',
      subject_id: SUBJECT_DOMAIN,
      outcome: 'success',
      payload: { proposal_id: proposalId, kind: 'cause_category' },
      caused_by_event_id: proposalId,
      created_at: new Date(),
    });
    // Learner marks the first relabelled original wrong (mark_wrong), retracts
    // the second (retract) — both canonical corrections on raw event ids. The
    // canonical fold orders by created_at, then dispatch_seq, then id; pinning
    // these to the same created_at as the accept's supersede while giving the
    // learner ids a lex-lower value means dispatch_seq alone decides the winner.
    // That ordering is exactly what an id-only / created_at-only ordering gets
    // backwards — the learner receipt must still win.
    const [supersede0] = await testDb()
      .select({ created_at: event.created_at })
      .from(event)
      .where(eq(event.subject_id, 'judge_evidence_0'));
    const sameClock = supersede0?.created_at ?? new Date();
    await writeEvent(testDb(), {
      id: 'a_learner_wrong',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'judge_evidence_0',
      outcome: 'success',
      payload: {
        correction_kind: 'mark_wrong',
        reason_md: 'learner: this judgment was wrong',
        affected_refs: [{ kind: 'question', id: QUESTION_ID }],
      },
      caused_by_event_id: 'judge_evidence_0',
      created_at: sameClock,
    });
    await writeEvent(testDb(), {
      id: 'a_learner_retract',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'judge_evidence_1',
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'learner: withdraw that judgment',
        affected_refs: [{ kind: 'question', id: QUESTION_ID }],
      },
      caused_by_event_id: 'judge_evidence_1',
      created_at: sameClock,
    });

    // The undo guard surfaces the learner-correction block before any write.
    const decisions = await classifyAutoAppliedUndoBatch(testDb(), [proposalId]);
    expect(decisions.get(proposalId)?.status).toBe('blocked');
    expect(decisions.get(proposalId)?.code).toBe('relabelled_original_learner_corrected');

    // Single-card retract is the canonical undo lane: it archives the category
    // and reverts only this accept's still-effective materialization. The two
    // learner-corrected originals keep their corrections (no effective 'other');
    // the untouched third original restores to 'other'.
    await retractAiProposal(testDb(), proposalId, { reason_md: 'undo' });
    const afterUndo = await effectiveCategories();
    // Learner-corrected originals have no effective active cause left — the
    // learner's mark_wrong/retract is the terminal correction truth.
    expect(afterUndo.get('att_evidence_0') ?? null).toBeNull(); // mark_wrong preserved
    expect(afterUndo.get('att_evidence_1') ?? null).toBeNull(); // retract preserved
    expect(afterUndo.get('att_evidence_2')).toBe('other'); // normal undo still works
  });
});
