// Phase 1 增量 3 (YUK-399/YUK-396) — verifyAndPromote 薄 tier-dispatcher (caller-agnostic gate).
//
// plan §Task 4 + Gate 设计决策 (owner 拍板 b1). 三个 caller 的统一 gate 入口:
//   ① matcher lazy verify (Task 5)  ② owner manual override (inc-4 UI)  ③ 未来 pre-warm.
// 它是一个**薄派发**: 按 source 字面转调现有 per-question runSourceVerify / runQuizVerify
// (整体调用)，**不合并、不重写**任何 verify / promote / metadata / writeAgentNote / catch
// 逻辑——那些全部由被转调的 run 函数天然产生 (三态/幂等/守门/note 全保留，blast radius 归零)。
//
// 唯一例外是 override 分支 (skipVerify): owner 强制启用、跳 AI verify，没有 run 函数可转调，
// 故此分支自己跑 promote (draft→active + FSRS enroll-if-absent + writeEvent)。它直接复用
// acceptQuestionDraftProposal (proposal-appliers.ts:286) 的 draft→active+FSRS 同形逻辑 (参照，
// 非 import)，与 run 函数同款 enroll-if-absent，绝不重置已有 schedule。
//
// 边界纪律 (plan §367 §9): 本模块**只能** import runSourceVerify / runQuizVerify (正常分支
// 转调) + 少量 promote 原语 (writeEvent / getFsrsState / upsertFsrsState / initialFsrsState，
// 仅 override 分支用)。派发判别按 source 字面 (web_sourced/quiz_gen)，比 deriveSourceTier 更稳。
// **绝不** import 或复刻两 handler 的 check 逻辑 / promote 事务 / metadata 构造 / writeAgentNote
// —— 那是「合并抽取」的滑坡，被 b1 决策否决。

import { initialFsrsState } from '@/capabilities/practice/server/fsrs';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { runQuizVerify } from '@/server/boss/handlers/quiz_verify';
import type { RunTaskFn } from '@/server/boss/handlers/quiz_verify';
import { runSourceVerify } from '@/server/boss/handlers/source_verify';
import { writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { and, desc, eq, ne } from 'drizzle-orm';

export interface VerifyAndPromoteParams {
  db: Db;
  /** 转调的 run 函数内部 re-SELECT (保留现有幂等/守门契约). */
  questionId: string;
  /** 透传给被转调的 run 函数 (db 测试注 vi.fn()). */
  runTaskFn: RunTaskFn;
  /** 默认 agent；owner manual (inc-4) 传 user. override 分支的 verify event actor. */
  actor?: { kind: 'agent' | 'user'; ref: string };
  /** override：跳 AI verify，直接 promote (inc-4 owner path，inc-3 实现+测). */
  skipVerify?: { reason: string };
  /** dispatch seam：默认转调真实 runSourceVerify/runQuizVerify；db 测试注 fake 验「派到哪个」. */
  deps?: {
    runSourceVerify?: typeof runSourceVerify;
    runQuizVerify?: typeof runQuizVerify;
  };
}

export interface VerifyAndPromoteResult {
  /** run 函数 status==='verified' (quiz 的 needs_review/failed → false). */
  promoted: boolean;
  /** 透传 run 函数 status ('verified'|'needs_review'|'failed'|'skipped:*'). */
  status: string;
  /** promote 留痕引用 (run 函数不返 id；promote 后按幂等查谓词回查；override 分支自产). */
  verifyEventId?: string;
  /** 不 promote 的状态/驳回理由. */
  reason?: string;
}

// source → experimental verify action (留痕 action 串不合并，plan §366 gotcha 8).
function verifyActionForSource(
  source: string,
): 'experimental:source_verify' | 'experimental:quiz_verify' {
  return source === 'web_sourced' ? 'experimental:source_verify' : 'experimental:quiz_verify';
}

// codex P2-6 — the only sources whose drafts may be promoted into the raw active pool:
// web_sourced (→ source_verify) / quiz_gen (→ quiz_verify). Container-scoped drafts
// (teaching_check / copilot_authored / embedded check / authentic / …) are NOT raw-pool
// promotable — the override branch must reject them just like the normal branch's source
// guard does (verifyActionForSource alone would mis-map them to experimental:quiz_verify).
function isPromotableSource(source: string): boolean {
  return source === 'web_sourced' || source === 'quiz_gen';
}

/**
 * Re-query the verify event id written by the转调 run fn on a successful promote. run 函数
 * 不返 verify event id (RunSourceVerifyResult/RunQuizVerifyResult 只返 status/checks/overall)，
 * 但 matcher 需要 verifyEventId 留痕。回查谓词 = run 函数内部幂等查的同款索引路径
 * (action, subject_kind='question', subject_id, outcome != 'error')，取最新一条。
 * 改 run 函数返 id 是后续 cleanup follow-up (不改 handler 签名，否则破 b1 等价回归).
 */
async function lookupVerifyEventId(
  db: Db,
  questionId: string,
  action: 'experimental:source_verify' | 'experimental:quiz_verify',
): Promise<string | undefined> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, action),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        ne(event.outcome, 'error'),
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  return rows[0]?.id;
}

/**
 * caller-agnostic gate. re-SELECT source+draft_status → branch:
 *   - skipVerify override → own promote txn (draft→active + FSRS + user-actor verify event).
 *   - web_sourced → runSourceVerify;  quiz_gen → runQuizVerify;  其它 → skipped:unsupported_source.
 * 正常分支把 run 函数 status 映射成 VerifyAndPromoteResult (promoted = status==='verified')，
 * promote 后回查 verifyEventId. **不重实现** 任何 promote/check/metadata/note —— 全在 run 函数里.
 */
export async function verifyAndPromote(p: VerifyAndPromoteParams): Promise<VerifyAndPromoteResult> {
  const { db, questionId, runTaskFn, skipVerify } = p;

  // 一次轻量 SELECT 取 source + draft_status (派发判别 + override promote 前置).
  const rows = await db
    .select({
      id: question.id,
      source: question.source,
      draft_status: question.draft_status,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { promoted: false, status: 'skipped:not_found', reason: 'question not found' };
  }

  // ── override 分支 (skipVerify) ──────────────────────────────────────────────
  // owner 强制启用：不调 run 函数，自己跑 promote (draft→active + FSRS enroll-if-absent +
  // user-actor verify event)。这是 inc-3 唯一需要 verifyAndPromote 自己写 promote 的分支——
  // 因为 owner override 跳过 verify，没有 run 函数可转调。复用 acceptQuestionDraftProposal 的
  // draft→active+FSRS 同形逻辑 (参照)。
  if (skipVerify) {
    // codex P2-6 — the override branch ran BEFORE the source guard, so a container draft
    // (teaching_check / copilot_authored / embedded check) whose source is not a raw-pool-
    // promotable source got force-promoted to active. Validate source + draft_status FIRST:
    //   ① only raw-pool-promotable sources (web_sourced / quiz_gen) may be promoted — anything
    //      else → skipped:unsupported_source (mirror the normal branch's source guard).
    //   ② only a true 'draft' is promotable (呼应 YUK-400 条目 5) — a non-draft row →
    //      skipped:not_draft.
    // Reject WITHOUT promoting or writing any verify event.
    if (!isPromotableSource(row.source)) {
      return { promoted: false, status: 'skipped:unsupported_source' };
    }
    if (row.draft_status !== 'draft') {
      return { promoted: false, status: 'skipped:not_draft' };
    }
    const action = verifyActionForSource(row.source);
    const actor = p.actor ?? { kind: 'agent' as const, ref: 'verify_and_promote' };
    const now = new Date();
    const verifyEventId = newId();

    await db.transaction(async (tx) => {
      await tx
        .update(question)
        .set({ draft_status: 'active', updated_at: now })
        .where(eq(question.id, questionId));

      // FSRS enroll — per-knowledge enroll-if-absent (mirror quiz_verify / source_verify /
      // acceptQuestionDraftProposal): never reset a node that already has a schedule;
      // question-level fallback when the row carries no knowledge ids.
      const initial = initialFsrsState(now);
      const fsrsSubjectIds = Array.from(new Set(row.knowledge_ids ?? []));
      if (fsrsSubjectIds.length > 0) {
        for (const knowledgeId of fsrsSubjectIds) {
          const existing = await getFsrsState(tx, 'knowledge', knowledgeId);
          if (existing) continue;
          await upsertFsrsState(tx, {
            subject_kind: 'knowledge',
            subject_id: knowledgeId,
            state: initial.state,
            due_at: initial.dueAt,
            last_review_event_id: verifyEventId,
          });
        }
      } else {
        const existing = await getFsrsState(tx, 'question', questionId);
        if (!existing) {
          await upsertFsrsState(tx, {
            subject_kind: 'question',
            subject_id: questionId,
            state: initial.state,
            due_at: initial.dueAt,
            last_review_event_id: verifyEventId,
          });
        }
      }

      // evidence-first 留痕: owner-override promote 写 actor_kind:'user' + skipped_verify:true
      // + reason，按 source 派生 action (不合并成单 experimental:verify，plan §366 gotcha 8).
      await writeEvent(tx, {
        id: verifyEventId,
        session_id: null,
        actor_kind: actor.kind,
        actor_ref: actor.ref,
        action,
        subject_kind: 'question',
        subject_id: questionId,
        outcome: 'success',
        payload: {
          question_id: questionId,
          promoted: true,
          skipped_verify: true,
          reason: skipVerify.reason,
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
    });

    return { promoted: true, status: 'skipped:owner_override', verifyEventId };
  }

  // ── 正常分支 = 薄派发 ───────────────────────────────────────────────────────
  // 按 source 字面转调现有 per-question run 函数 (整体调用)。三态 / writeAgentNote note /
  // metadata 写回 / catch / 幂等 / 非-draft 守门全部由被转调的 run 函数天然产生.
  const runSourceVerifyFn = p.deps?.runSourceVerify ?? runSourceVerify;
  const runQuizVerifyFn = p.deps?.runQuizVerify ?? runQuizVerify;

  // source 字面优先 (比 deriveSourceTier 更稳；tier ∈ {1,2} ≈ source/sourced 走 source_verify，
  // tier ∈ {3,4} ≈ material/generated 走 quiz_verify，但 draft verify 现实只有这两个 source).
  let status: string;
  if (row.source === 'web_sourced') {
    const r = await runSourceVerifyFn({ db, questionId, runTaskFn });
    status = r.status;
  } else if (row.source === 'quiz_gen') {
    const r = await runQuizVerifyFn({ db, questionId, runTaskFn });
    status = r.status;
  } else {
    // 防御：现实只有 web_sourced / quiz_gen 进 draft verify。其它 source 不派发。
    return { promoted: false, status: 'skipped:unsupported_source' };
  }

  // codex P2-5 — an eager verify can promote the row BEFORE this lazy call lands. Then the
  // run fn short-circuits as skipped:already_verified (terminal verify event exists) but the
  // row is ALREADY active. Treating that as promoted:false (status !== 'verified') would make
  // the matcher skip a perfectly usable row. Re-SELECT on already_verified: if the row is no
  // longer a draft (eager promote happened), report it as promoted + surface the existing
  // verify event id. If it's still a draft (the terminal event was a failed/needs_review
  // verdict, not a promote), keep the honest not-promoted result.
  if (status === 'skipped:already_verified') {
    const post = await db
      .select({ draft_status: question.draft_status })
      .from(question)
      .where(eq(question.id, questionId))
      .limit(1);
    const alreadyActive = post[0] !== undefined && post[0].draft_status !== 'draft';
    if (alreadyActive) {
      const verifyEventId = await lookupVerifyEventId(
        db,
        questionId,
        verifyActionForSource(row.source),
      );
      return { promoted: true, status, verifyEventId };
    }
  }

  const promoted = status === 'verified';
  let verifyEventId: string | undefined;
  if (promoted) {
    verifyEventId = await lookupVerifyEventId(db, questionId, verifyActionForSource(row.source));
  }

  return {
    promoted,
    status,
    verifyEventId,
    // needs_review / failed / skipped:* 时把 status 折成 reason (非 promote 的驳回理由).
    ...(promoted ? {} : { reason: status }),
  };
}
