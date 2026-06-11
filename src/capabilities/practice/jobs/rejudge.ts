// M2 (YUK-316, D15) — 申诉自动重判 pg-boss handler。
//
// 链路（P2 spec §2.3）：appeal_request event → 本 job → judge 带用户理由重跑
// （judge_kind_override='semantic' 强制语义复核，appeal_context 注入异议）→
//   改判：新 judge event（newest-wins，D6）+ CorrectEvent(supersede) 留痕，直接生效
//   不改判：experimental:appeal_upheld event 留痕（带复核理由）
// 无 proposal（判分属软判断层）；幂等键 = appeal_request event id（boss
// singletonKey + 本 handler 的 caused_by 查重双保险）。
//
// FSRS 刻意不在此重写：设计稿语义里评级是用户确认动作——改判回执把「评级建议
// 上调」推回反馈卡，用户确认评级走既有 submit/rate 单一入口；全历史重投影属
// 投影引擎契约（总 spec 按第二实例原则推迟）。

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { type JudgeAnswerResult, judgeAnswer } from '@/server/ai/judges/question-contract';
import { writeEvent } from '@/server/events/queries';
import { and, eq } from 'drizzle-orm';

export interface RejudgeJobInput {
  appeal_event_id: string;
}

export interface RejudgeDeps {
  /** 测试注入：替换真 LLM 判分。 */
  judgeFn?: typeof judgeAnswer;
}

export type RejudgeOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'upheld'; appeal_event_id: string; upheld_event_id: string }
  | {
      status: 'overturned';
      appeal_event_id: string;
      new_judge_event_id: string;
      correction_event_id: string;
      prior_outcome: string;
      new_outcome: string;
    };

export async function handleRejudge(
  db: Db,
  input: RejudgeJobInput,
  deps: RejudgeDeps = {},
): Promise<RejudgeOutcome> {
  const judgeFn = deps.judgeFn ?? judgeAnswer;

  const [appeal] = await db.select().from(event).where(eq(event.id, input.appeal_event_id));
  if (!appeal || appeal.action !== 'experimental:appeal_request') {
    return { status: 'skipped', reason: 'appeal_event_not_found' };
  }
  // 幂等：本申诉已产生过重判结论（改判 judge 或维持 appeal_upheld）则跳过。
  const [existing] = await db
    .select({ id: event.id })
    .from(event)
    .where(eq(event.caused_by_event_id, appeal.id));
  if (existing) return { status: 'skipped', reason: 'already_resolved' };

  const [judgeEvent] = await db
    .select()
    .from(event)
    .where(and(eq(event.id, appeal.subject_id), eq(event.action, 'judge')));
  if (!judgeEvent) return { status: 'skipped', reason: 'judge_event_not_found' };

  // judge.subject = 作答事件（卷题 attempt / 散题 review）。
  const [answerEvent] = await db.select().from(event).where(eq(event.id, judgeEvent.subject_id));
  if (!answerEvent) return { status: 'skipped', reason: 'answer_event_not_found' };
  const answerPayload = answerEvent.payload as Record<string, unknown>;
  const answerMd =
    (typeof answerPayload.answer_md === 'string' && answerPayload.answer_md) ||
    (typeof answerPayload.user_response_md === 'string' && answerPayload.user_response_md) ||
    '';
  const questionId = answerEvent.subject_id;

  const [q] = await db.select().from(question).where(eq(question.id, questionId));
  if (!q) return { status: 'skipped', reason: 'question_not_found' };

  const judgePayload = judgeEvent.payload as Record<string, unknown>;
  const priorOutcome =
    typeof judgePayload.coarse_outcome === 'string' ? judgePayload.coarse_outcome : 'unknown';
  const reasonMd =
    typeof (appeal.payload as Record<string, unknown>).reason_md === 'string'
      ? ((appeal.payload as Record<string, unknown>).reason_md as string)
      : '';

  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);
  const invoked: JudgeAnswerResult = await judgeFn({
    db,
    question: { ...q, judge_kind_override: 'semantic' },
    answer_md: answerMd,
    subjectProfile,
    appeal_context: { prior_outcome: priorOutcome, user_reason_md: reasonMd },
  });

  const now = new Date();
  const newOutcome = invoked.result.coarse_outcome;

  // 复核结论与原判一致（或复核不可用）→ 维持原判留痕。
  if (newOutcome === priorOutcome || newOutcome === 'unsupported') {
    const upheldId = await writeEvent(db, {
      id: newId(),
      session_id: judgeEvent.session_id,
      actor_kind: 'agent',
      actor_ref: 'rejudge',
      action: 'experimental:appeal_upheld',
      subject_kind: 'event',
      subject_id: judgeEvent.id,
      outcome: null,
      payload: {
        reason_md: invoked.result.feedback_md,
        prior_outcome: priorOutcome,
        rejudge_outcome: newOutcome,
        appeal_event_id: appeal.id,
      },
      caused_by_event_id: appeal.id,
      created_at: now,
    });
    return { status: 'upheld', appeal_event_id: appeal.id, upheld_event_id: upheldId };
  }

  // 改判：新 judge event（newest-wins 盖掉原判）+ CorrectEvent(supersede) 留痕。
  const newJudgeId = await writeEvent(db, {
    id: newId(),
    session_id: judgeEvent.session_id,
    actor_kind: 'agent',
    actor_ref: 'rejudge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: judgeEvent.subject_id,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '<rejudge, attribution deferred>',
        confidence: invoked.result.confidence,
      },
      referenced_knowledge_ids: q.knowledge_ids,
      profile_version: invoked.result.capability_ref.version,
      capability_ref: invoked.result.capability_ref,
      judge_route: invoked.route,
      coarse_outcome: newOutcome,
      ...(invoked.result.score != null ? { score: invoked.result.score } : {}),
      feedback_md: invoked.result.feedback_md,
      appeal_event_id: appeal.id,
      attribution_pending: true,
    },
    caused_by_event_id: appeal.id,
    created_at: now,
  });

  const correctionId = await writeEvent(db, {
    id: newId(),
    session_id: judgeEvent.session_id,
    // CorrectEvent schema 限定 user/self：申诉是用户发起的语义修正，重判只是
    // 它的执行臂——correction 以用户署名，caused_by 链到重判 judge event 可追溯。
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: judgeEvent.id,
    outcome: 'success',
    payload: {
      correction_kind: 'supersede',
      replacement_event_id: newJudgeId,
      reason_md: `申诉重判改判（${priorOutcome} → ${newOutcome}）：${reasonMd || '用户对原判定提出异议'}`,
      affected_refs: [{ kind: 'question', id: questionId }],
    },
    caused_by_event_id: newJudgeId,
    created_at: now,
  });

  return {
    status: 'overturned',
    appeal_event_id: appeal.id,
    new_judge_event_id: newJudgeId,
    correction_event_id: correctionId,
    prior_outcome: priorOutcome,
    new_outcome: newOutcome,
  };
}
