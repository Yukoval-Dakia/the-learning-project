// Phase 1 增量 3 (YUK-399/YUK-396) — verifyAndPromote 薄 dispatcher DB test.
//
// plan §Task 4. verifyAndPromote 是 caller-agnostic gate：
//   - 正常分支 = 薄派发，按 source 字面转调现有 runSourceVerify / runQuizVerify（整体调用，
//     不重实现 promote/check/metadata/note；三态/幂等/守门全由被转调 run 函数天然产生）。
//   - override 分支 (skipVerify) = owner 强制启用，跳 AI verify，自己跑 promote
//     (draft→active + FSRS enroll-if-absent + writeEvent actor_kind:'user' + skipped_verify:true)。
//   - verifyEventId = promote 后按幂等查谓词回查 verify event id（run 函数不返 id；不改 handler 签名）。
//
// db 测试注入 fake run seam（vi.fn()）验「派到哪个 verify」+ status 透传，不打真 AI。

import { and, eq, ne } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import type {
  QuizVerifyPerQuestionStatus,
  RunQuizVerifyResult,
} from '@/server/boss/handlers/quiz_verify';
import type {
  RunSourceVerifyResult,
  SourceVerifyPerQuestionStatus,
} from '@/server/boss/handlers/source_verify';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { verifyAndPromote } from './verify-and-promote';

async function seedKnowledge(id: string, domain = 'wenyan') {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

interface SeedQuestionOpts {
  id?: string;
  source?: string;
  draftStatus?: string | null;
  knowledgeIds?: string[];
}

async function seedQuestion(opts: SeedQuestionOpts = {}): Promise<string> {
  const db = testDb();
  const now = new Date();
  const id = opts.id ?? `q-${Math.random().toString(36).slice(2)}`;
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: 'P',
    reference_md: 'R',
    choices_md: null,
    judge_kind_override: 'exact',
    knowledge_ids: opts.knowledgeIds ?? ['k1'],
    difficulty: 2,
    source: opts.source ?? 'quiz_gen',
    source_ref: null,
    draft_status: opts.draftStatus === undefined ? 'draft' : opts.draftStatus,
    created_by: { by: 'ai', task_kind: 'QuizGenTask' },
    metadata: {} as never,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

// A loose runTaskFn that must NOT be consulted in dispatch-spy / override tests.
const noRunTask = vi.fn(async () => {
  throw new Error('runTaskFn should not be called in this test');
});

function sourceResult(status: SourceVerifyPerQuestionStatus): RunSourceVerifyResult {
  return { status };
}
function quizResult(status: QuizVerifyPerQuestionStatus): RunQuizVerifyResult {
  return { status };
}

describe('verifyAndPromote — Task 4 (薄 dispatcher)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('dispatches web_sourced draft to runSourceVerify only (Step 1)', async () => {
    const db = testDb();
    const qid = await seedQuestion({ source: 'web_sourced' });
    const spyA = vi.fn(async () => sourceResult('verified'));
    const spyB = vi.fn(async () => quizResult('verified'));

    await verifyAndPromote({
      db,
      questionId: qid,
      runTaskFn: noRunTask,
      deps: { runSourceVerify: spyA, runQuizVerify: spyB },
    });

    expect(spyA).toHaveBeenCalledTimes(1);
    expect(spyA).toHaveBeenCalledWith({ db, questionId: qid, runTaskFn: noRunTask });
    expect(spyB).not.toHaveBeenCalled();
  });

  it('dispatches quiz_gen draft to runQuizVerify only (Step 2)', async () => {
    const db = testDb();
    const qid = await seedQuestion({ source: 'quiz_gen' });
    const spyA = vi.fn(async () => sourceResult('verified'));
    const spyB = vi.fn(async () => quizResult('verified'));

    await verifyAndPromote({
      db,
      questionId: qid,
      runTaskFn: noRunTask,
      deps: { runSourceVerify: spyA, runQuizVerify: spyB },
    });

    expect(spyB).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledWith({ db, questionId: qid, runTaskFn: noRunTask });
    expect(spyA).not.toHaveBeenCalled();
  });

  it('maps run status → promoted (verified true; failed/needs_review false), three states (Step 3)', async () => {
    const db = testDb();

    // verified → promoted:true
    const q1 = await seedQuestion({ source: 'web_sourced' });
    const r1 = await verifyAndPromote({
      db,
      questionId: q1,
      runTaskFn: noRunTask,
      deps: { runSourceVerify: vi.fn(async () => sourceResult('verified')) },
    });
    expect(r1.promoted).toBe(true);
    expect(r1.status).toBe('verified');

    // failed → promoted:false + non-empty reason
    const q2 = await seedQuestion({ source: 'web_sourced' });
    const r2 = await verifyAndPromote({
      db,
      questionId: q2,
      runTaskFn: noRunTask,
      deps: { runSourceVerify: vi.fn(async () => sourceResult('failed')) },
    });
    expect(r2.promoted).toBe(false);
    expect(r2.status).toBe('failed');
    expect(r2.reason).toBeTruthy();

    // quiz needs_review → promoted:false (三态如实透传)
    const q3 = await seedQuestion({ source: 'quiz_gen' });
    const r3 = await verifyAndPromote({
      db,
      questionId: q3,
      runTaskFn: noRunTask,
      deps: { runQuizVerify: vi.fn(async () => quizResult('needs_review')) },
    });
    expect(r3.promoted).toBe(false);
    expect(r3.status).toBe('needs_review');
  });

  it('override (skipVerify) promotes without calling any run fn + writes user-actor verify event (Step 4)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ source: 'quiz_gen', knowledgeIds: ['k1'] });

    const runSpy = vi.fn(async () => quizResult('verified'));
    const result = await verifyAndPromote({
      db,
      questionId: qid,
      runTaskFn: noRunTask,
      actor: { kind: 'user', ref: 'owner' },
      skipVerify: { reason: 'owner 判断' },
      deps: { runQuizVerify: runSpy },
    });

    expect(result.promoted).toBe(true);
    expect(result.verifyEventId).toBeTruthy();

    // DB row promoted to active.
    const row = (await db.select().from(question).where(eq(question.id, qid)).limit(1))[0];
    expect(row.draft_status).toBe('active');

    // FSRS card materialized (knowledge-level, enroll-if-absent).
    const fsrs = await db
      .select()
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          eq(material_fsrs_state.subject_id, 'k1'),
        ),
      )
      .limit(1);
    expect(fsrs).toHaveLength(1);

    // Verify event: experimental:quiz_verify (source-derived action), actor_kind=user,
    // skipped_verify:true + reason in payload.
    const ev = (
      await db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:quiz_verify'),
            eq(event.subject_kind, 'question'),
            eq(event.subject_id, qid),
          ),
        )
        .limit(1)
    )[0];
    expect(ev).toBeDefined();
    expect(ev.actor_kind).toBe('user');
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.skipped_verify).toBe(true);
    expect(payload.reason).toBe('owner 判断');
    expect(ev.id).toBe(result.verifyEventId);

    // Neither runTaskFn nor the injected run spy was consulted (no AI on override).
    expect(noRunTask).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('verifyEventId resolves to the verify event written by the run fn (回查, Step 5)', async () => {
    const db = testDb();
    const qid = await seedQuestion({ source: 'web_sourced' });

    // fake runSourceVerify that itself promotes + writes a source_verify event,
    // exactly like the real handler does on a passing verify.
    const fakeEventId = 'ev-source-1';
    const fakeRunSource = vi.fn(async (): Promise<RunSourceVerifyResult> => {
      const now = new Date();
      await db
        .update(question)
        .set({ draft_status: 'active', updated_at: now })
        .where(eq(question.id, qid));
      await db.insert(event).values({
        id: fakeEventId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'source_verify',
        action: 'experimental:source_verify',
        subject_kind: 'question',
        subject_id: qid,
        outcome: 'success',
        payload: { question_id: qid, promoted: true },
        created_at: now,
      });
      return { status: 'verified' };
    });

    const result = await verifyAndPromote({
      db,
      questionId: qid,
      runTaskFn: noRunTask,
      deps: { runSourceVerify: fakeRunSource },
    });

    expect(result.promoted).toBe(true);
    expect(result.verifyEventId).toBe(fakeEventId);
  });

  it('idempotency: a verify event with outcome != error short-circuits the回查 to it', async () => {
    // sanity that 回查 谓词 (action, subject_kind, subject_id, outcome != error) matches the
    // same index path the run-fn idempotency uses; covered structurally above. Here just
    // assert verifyEventId is undefined when the run fn did NOT promote (no回查 target).
    const db = testDb();
    const qid = await seedQuestion({ source: 'quiz_gen' });
    const result = await verifyAndPromote({
      db,
      questionId: qid,
      runTaskFn: noRunTask,
      deps: { runQuizVerify: vi.fn(async () => quizResult('failed')) },
    });
    expect(result.promoted).toBe(false);
    expect(result.verifyEventId).toBeUndefined();
    // double-check no stray event was queried into existence.
    const evs = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:quiz_verify'),
          eq(event.subject_id, qid),
          ne(event.outcome, 'error'),
        ),
      );
    expect(evs).toHaveLength(0);
  });

  it('unsupported source → skipped:unsupported_source, no run fn called (defensive)', async () => {
    const db = testDb();
    const qid = await seedQuestion({ source: 'authentic' });
    const spyA = vi.fn(async () => sourceResult('verified'));
    const spyB = vi.fn(async () => quizResult('verified'));
    const result = await verifyAndPromote({
      db,
      questionId: qid,
      runTaskFn: noRunTask,
      deps: { runSourceVerify: spyA, runQuizVerify: spyB },
    });
    expect(result.promoted).toBe(false);
    expect(result.status).toBe('skipped:unsupported_source');
    expect(spyA).not.toHaveBeenCalled();
    expect(spyB).not.toHaveBeenCalled();
  });
});
