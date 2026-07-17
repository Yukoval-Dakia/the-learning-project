// M2 (YUK-316, D15) — 申诉自动重判 pg-boss handler。
//
// 链路（P2 spec §2.3）：appeal_request event → 本 job → judge 带用户理由重跑
// （judge_kind_override='semantic' 强制语义复核，appeal_context 注入异议）→
//   改判：新 judge event（newest-wins，D6）+ CorrectEvent(supersede) 留痕，直接生效
//   不改判：experimental:appeal_upheld event 留痕（带复核理由）
// 无 proposal（判分属软判断层）；幂等键 = appeal_request event id。两道去重：
// ① send 层 singletonKey + singletonSeconds（REJUDGE_SINGLETON_SECONDS）杀重复
//   enqueue（YUK-491：裸 singletonKey 在 standard-policy 队列上 inert，需配
//   singletonSeconds 才真生效）；② 本 handler 下方 caused_by 查重 = 结构性兜底
//   （快速跳过）；最终写入事务再按 appeal id 取 advisory xact lock 并重查，
//   关闭两个 worker 同时越过快速守卫的 TOCTOU 窗口（YUK-564）。
//
// FSRS 段刻意不在此重写：设计稿语义里评级是用户确认动作——改判回执把「评级建议
// 上调」推回反馈卡，用户确认评级走既有 submit/rate 单一入口。
//
// θ̂ 段（YUK-561 S4）现已接 live：overturn 在双触发门（judgeDriven && bitFlip）成立
// 时撤 `${answerEvent.id}:checkpoint:theta`（O2 双 sibling，只撤 θ̂ 不碰 FSRS），与
// 改判写同一 db.transaction 原子提交。revert-only 只抹错误 transition、不 re-apply
// 正确 outcome（第二实例原则）——每次触及 θ̂ 的 overturn 都写 experimental:reproject_
// deferred marker 喂第二实例重投影引擎（全历史重投影仍属投影引擎契约，独立 issue）。

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { type JudgeAnswerResult, judgeAnswer } from '@/server/ai/judges/question-contract';
import { writeEvent } from '@/server/events/queries';
import { orchestrateCascadeRevert } from '@/server/revert/cascade-revert';
import { and, eq, isNull, sql } from 'drizzle-orm';

export interface RejudgeJobInput {
  appeal_event_id: string;
}

export interface RejudgeDeps {
  /** 测试注入：替换真 LLM 判分。 */
  judgeFn?: typeof judgeAnswer;
  /** 测试注入：替换 θ̂ revert（YUK-561 S4 原子性/瞬时失败注入测试用）。 */
  orchestrateRevert?: typeof orchestrateCascadeRevert;
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

type RejudgeDb = Db | Tx;

async function appealAlreadyResolved(db: RejudgeDb, appealId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: event.id })
    .from(event)
    .where(eq(event.caused_by_event_id, appealId))
    .limit(1);
  return existing !== undefined;
}

async function lockAppealResolution(tx: Tx, appealId: string): Promise<void> {
  // Commit-stage lock only: the expensive judge call stays outside a DB tx.
  // 64-bit hash keeps unrelated-appeal collision risk negligible; xact scope
  // guarantees release on commit/rollback without a cleanup path.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${appealId}, 0))`);
}

export async function handleRejudge(
  db: Db,
  input: RejudgeJobInput,
  deps: RejudgeDeps = {},
): Promise<RejudgeOutcome> {
  const judgeFn = deps.judgeFn ?? judgeAnswer;
  const orchestrateRevert = deps.orchestrateRevert ?? orchestrateCascadeRevert;

  const [appeal] = await db.select().from(event).where(eq(event.id, input.appeal_event_id));
  if (!appeal || appeal.action !== 'experimental:appeal_request') {
    return { status: 'skipped', reason: 'appeal_event_not_found' };
  }
  // 幂等：本申诉已产生过重判结论（改判 judge 或维持 appeal_upheld）则跳过。
  if (await appealAlreadyResolved(db, appeal.id)) {
    return { status: 'skipped', reason: 'already_resolved' };
  }

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
    const upheldId = await db.transaction(async (tx) => {
      await lockAppealResolution(tx, appeal.id);
      if (await appealAlreadyResolved(tx, appeal.id)) return null;
      return writeEvent(tx, {
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
    });
    if (!upheldId) return { status: 'skipped', reason: 'already_resolved' };
    return { status: 'upheld', appeal_event_id: appeal.id, upheld_event_id: upheldId };
  }

  // 改判（YUK-561 S4 / Q2a 原子）：新 judge event（newest-wins）+ CorrectEvent
  // (supersede) + θ̂ revert + 残留 marker，全部同一 db.transaction 原子提交——改判
  // 与 θ̂ 自愈同生共死。部分失败整体回滚，重试从头干净重放，caused_by 幂等守卫
  // （rejudge.ts:58-62）对真完成 run 语义恢复正确。
  //
  // 双触发门（Q2b）：θ̂ revert 只在两条件同时成立时触发——
  //   ① judgeDriven：判决实际驱动了 θ̂。paper attempt 恒判决驱动；solo review 仅
  //      auto_rate=true（否则 θ̂ 来自用户手评 body.rating，撤它是纯污染——与
  //      family-calibration 手评门同源判例）。
  //   ② bitFlip：改判翻转了 θ̂ 位（bit(coarse)=coarse∈{correct,partial}?1:0）。
  //      partial→correct 位未翻，θ̂ transition 本就是正确位的更新，revert 会删合法
  //      信号 → 不 revert、不 marker（O3 owner 拍零 marker：无 θ̂ 残留则无可审计之物，
  //      overturn 本身在事件链可查）。
  const answerJudge = answerPayload.judge as { auto_rated?: boolean } | undefined;
  const judgeDriven =
    answerEvent.action === 'attempt' ||
    (answerEvent.action === 'review' && answerJudge?.auto_rated === true);
  // A θ̂-skipped prior (unsupported/unknown — θ̂ never moved, no bracket) has NO bit;
  // outcomeBit conflates it with the failure bit (0), silently dropping the
  // unsupported→incorrect residual marker (spec §Q2b(3)). Route any skipped-prior overturn
  // to a θ̂-meaningful new outcome through the revert path (→ no_checkpoint → marker),
  // symmetric with unsupported→correct/partial. (newOutcome guaranteed θ̂-meaningful here
  // — 'unsupported' is filtered as upheld at line 113.)
  // Note (PR #704 OCR round): 'unknown' is a pure defensive/type branch — it is the
  // `coarse_outcome`-missing fallback (:94), but every appeal targets a placeholder judge
  // that unconditionally writes a real CoarseOutcome (submit.ts:610 / paper-submit.ts:602),
  // so priorOutcome='unknown' is unreachable via the live appeal path. Even if forced, a
  // coarse_outcome-less judge ⟺ no judge-driven θ̂ move (photo-unsupported has no checkpoint;
  // solo-manual has judgeDriven=false), so it can never over-revert a real correct/partial.
  const thetaSkippedPrior = priorOutcome === 'unsupported' || priorOutcome === 'unknown';
  const shouldRevertTheta =
    judgeDriven && (thetaSkippedPrior || outcomeBit(priorOutcome) !== outcomeBit(newOutcome));

  let newJudgeId = '';
  let correctionId = '';

  const committed = await db.transaction(async (tx) => {
    await lockAppealResolution(tx, appeal.id);
    if (await appealAlreadyResolved(tx, appeal.id)) return false;

    newJudgeId = await writeEvent(tx, {
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

    correctionId = await writeEvent(tx, {
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

    // O3：门不满足（手评 solo / 位未翻转）→ 无 θ̂ 残留 → 不 revert、不写 marker。
    if (!shouldRevertTheta) return true;

    // 撤 θ̂ 段 = 撤 θ̂ checkpoint（O2 双 sibling，无 revertSegments；只撤 θ̂ 不碰 FSRS）。
    // 同 tx——orchestrator step-6 在此 tx 上开 SAVEPOINT，conflict/legacy 回滚 savepoint
    // 后以 refusal 返回（外层 tx 仍活），caller 在同 tx 写 marker + 整体 commit。
    const revert = await orchestrateRevert(tx, `${answerEvent.id}:checkpoint:theta`, {
      reasonContext: { appeal_event_id: appeal.id, note: `${priorOutcome}→${newOutcome}` },
    });

    // 四态分派（Q2c/Q2d）——marker 全部同 tx，caused_by=appeal.id（与幂等守卫同键族）。
    const markerBase = {
      appealId: appeal.id,
      answerEventId: answerEvent.id,
      sessionId: judgeEvent.session_id,
      priorOutcome,
      newOutcome,
      now,
    } as const;
    if (revert.ok) {
      // happy-path 也写 marker（Q2d）：revert-only 未 re-apply 正确 outcome →
      // 第二实例 worklist 必须含它，否则 happy-path 残留从视野消失。
      await writeReprojectDeferred(tx, {
        ...markerBase,
        residual: 'reapply_correct_outcome',
        reason: 'reverted',
      });
    } else if (revert.refusal === 'no_checkpoint' || revert.refusal === 'legacy_snapshot') {
      // 旧 attempt / 无快照 / legacy bare-number → honest 排队全量重投影。
      await writeReprojectDeferred(tx, {
        ...markerBase,
        residual: 'full_reprojection',
        reason: 'no_checkpoint',
      });
    } else if (revert.refusal === 'conflict') {
      // 后续 attempt 动过该 KC → 撤会 clobber 合法信号 → defer；带 best-effort merge 定位。
      const mergedInto = await resolveMergedInto(tx, revert.conflictRef.subjectId);
      await writeReprojectDeferred(tx, {
        ...markerBase,
        residual: 'full_reprojection',
        reason: 'later_theta_movement',
        kc_conflict: revert.conflictRef,
        merged_into: mergedInto,
      });
    } else {
      // truncated / irreversible：C_θ 闭包只有 snapshot(reversible) + checkpoint(event_layer)，
      // 这两态结构性不可能。若发生 = 拓扑损坏的严重 bug → fail-loud throw（回滚整个
      // overturn，pg-boss 重试 / DLQ 可见），绝不当成功静默 commit（Q2c，绝不假完成）。
      throw new Error(
        `rejudge overturn: cascade revert of ${answerEvent.id}:checkpoint:theta returned impossible refusal '${revert.refusal}' — a θ̂ checkpoint closure must be reversible. Aborting overturn (fail-loud).`,
      );
    }
    return true;
  });

  if (!committed) return { status: 'skipped', reason: 'already_resolved' };

  return {
    status: 'overturned',
    appeal_event_id: appeal.id,
    new_judge_event_id: newJudgeId,
    correction_event_id: correctionId,
    prior_outcome: priorOutcome,
    new_outcome: newOutcome,
  };
}

/** bit(coarse) = coarse ∈ {correct, partial} ? 1 : 0 (YUK-561 S4 Q2b bit-flip gate). */
function outcomeBit(coarse: string): 0 | 1 {
  return coarse === 'correct' || coarse === 'partial' ? 1 : 0;
}

/**
 * Best-effort YUK-543 merge-chain lookup (Q3 KC-merge seam): after a KC merge the
 * winner's `merged_from` array contains the loser KC id. Returns the winner id, or
 * undefined when no merge target is found (the common conflict is a LATER attempt, not
 * a merge) — just a locating hint for the second-instance reprojection engine.
 */
async function resolveMergedInto(tx: Tx, kcId: string): Promise<string | undefined> {
  const rows = await tx
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(
      and(
        sql`${knowledge.merged_from} @> ${JSON.stringify([kcId])}::jsonb`,
        isNull(knowledge.archived_at),
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

/** Write the judge-overturn residual-visibility marker (YUK-561 S4 §4.5), same tx. */
async function writeReprojectDeferred(
  tx: Tx,
  params: {
    appealId: string;
    answerEventId: string;
    sessionId: string | null;
    priorOutcome: string;
    newOutcome: string;
    now: Date;
    residual: 'reapply_correct_outcome' | 'full_reprojection';
    reason: 'reverted' | 'no_checkpoint' | 'later_theta_movement';
    kc_conflict?: { kind: 'theta' | 'fsrs'; subjectKind: string; subjectId: string };
    merged_into?: string;
  },
): Promise<void> {
  await writeEvent(tx, {
    id: newId(),
    session_id: params.sessionId,
    actor_kind: 'agent',
    actor_ref: 'rejudge',
    action: 'experimental:reproject_deferred',
    subject_kind: 'event',
    subject_id: params.answerEventId,
    outcome: 'success',
    payload: {
      appeal_event_id: params.appealId,
      answer_event_id: params.answerEventId,
      residual: params.residual,
      reason: params.reason,
      ...(params.kc_conflict ? { kc_conflict: params.kc_conflict } : {}),
      ...(params.merged_into ? { merged_into: params.merged_into } : {}),
      prior_outcome: params.priorOutcome,
      new_outcome: params.newOutcome,
    },
    caused_by_event_id: params.appealId,
    // Internal reprojection-worklist ledger row — opt out of the memory outbox.
    ingest_at: params.now,
    created_at: params.now,
  });
}
