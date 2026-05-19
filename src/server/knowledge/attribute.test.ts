import { cost_ledger, event, question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { parseAttributionOutput, runAttributionAndWriteJudgeEvent } from './attribute';

describe('parseAttributionOutput', () => {
  it('parses well-formed JSON with analysis_md (Lane B field name)', () => {
    const text =
      '{"primary_category":"concept","secondary_categories":["memory"],"analysis_md":"用户混淆了「之」的助词和动词用法","confidence":0.85}';
    const out = parseAttributionOutput(text);
    expect(out.primary_category).toBe('concept');
    expect(out.secondary_categories).toEqual(['memory']);
    expect(out.analysis_md).toBe('用户混淆了「之」的助词和动词用法');
    expect(out.confidence).toBe(0.85);
  });

  it('rejects legacy ai_analysis_md (Step 7 removed the Zod bridge)', () => {
    const text =
      '{"primary_category":"concept","secondary_categories":[],"ai_analysis_md":"legacy field name","confidence":0.5}';
    // Bridge removed — schema now requires analysis_md natively.
    expect(() => parseAttributionOutput(text)).toThrow();
  });

  it('extracts JSON from text with surrounding prose', () => {
    const text =
      '分析如下：\n\n{"primary_category":"reading","secondary_categories":[],"analysis_md":"未注意「之」位置","confidence":0.6}\n\n以上。';
    const out = parseAttributionOutput(text);
    expect(out.primary_category).toBe('reading');
  });

  it('defaults secondary_categories to []', () => {
    const text = '{"primary_category":"other","analysis_md":"无法判断","confidence":0.2}';
    const out = parseAttributionOutput(text);
    expect(out.secondary_categories).toEqual([]);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseAttributionOutput('完全不是 JSON')).toThrow();
  });

  it('accepts math-specific primary_category against the math profile', () => {
    const text =
      '{"primary_category":"unit_error","secondary_categories":["calculation"],"analysis_md":"单位换算错误","confidence":0.8}';
    const out = parseAttributionOutput(text, resolveSubjectProfile('math'));
    expect(out.primary_category).toBe('unit_error');
    expect(out.secondary_categories).toEqual(['calculation']);
  });

  it('degrades profile-invalid primary_category to other while preserving analysis', () => {
    const text = '{"primary_category":"bogus","analysis_md":"r","confidence":0.5}';
    const out = parseAttributionOutput(text, resolveSubjectProfile('math'));
    expect(out.primary_category).toBe('other');
    expect(out.analysis_md).toBe('r');
  });

  it('throws when confidence out of range', () => {
    const text = '{"primary_category":"concept","analysis_md":"r","confidence":1.5}';
    expect(() => parseAttributionOutput(text)).toThrow();
  });

  it('throws when analysis_md missing', () => {
    const text = '{"primary_category":"concept","confidence":0.5}';
    expect(() => parseAttributionOutput(text)).toThrow();
  });
});

async function insertAttemptEvent(opts: { attemptId: string; questionId: string }) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.questionId,
    kind: 'short_answer',
    prompt_md: 'test prompt',
    reference_md: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'test',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(event).values({
    id: opts.attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
}

describe('runAttributionAndWriteJudgeEvent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const validInput = {
    prompt_md: '"之"在主谓之间的用法?',
    reference_md: '取消句子独立性',
    wrong_answer_md: '助词',
    knowledge_context: [{ id: 'k_xuci', name: '虚词', effective_domain: 'wenyan' }],
  };

  it('writes a judge event chained on the attempt with cause from LLM output', async () => {
    const db = testDb();
    const attemptId = 'attempt_e1';
    await insertAttemptEvent({ attemptId, questionId: 'q1' });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"why","confidence":0.8}',
    });
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
    });
    const judgeRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(judgeRows).toHaveLength(1);
    const judge = judgeRows[0];
    expect(judge.subject_kind).toBe('event');
    expect(judge.subject_id).toBe(attemptId);
    expect(judge.outcome).toBe('success');
    const payload = judge.payload as {
      cause: { primary_category: string; analysis_md: string; confidence: number };
    };
    expect(payload.cause.primary_category).toBe('concept');
    expect(payload.cause.analysis_md).toBe('why');
    expect(payload.cause.confidence).toBe(0.8);
  });

  it('writes math-specific attribution causes when subjectProfile is math', async () => {
    const db = testDb();
    const attemptId = 'attempt_e_math';
    await insertAttemptEvent({ attemptId, questionId: 'q_math' });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"unit_error","secondary_categories":[],"analysis_md":"单位换算错误","confidence":0.8}',
    });
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
      subjectProfile: resolveSubjectProfile('math'),
    });
    const judgeRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(judgeRows).toHaveLength(1);
    const payload = judgeRows[0].payload as { cause: { primary_category: string } };
    expect(payload.cause.primary_category).toBe('unit_error');
  });

  it('does NOT bridge legacy ai_analysis_md — surfaces as parse error (no judge written)', async () => {
    const db = testDb();
    const attemptId = 'attempt_e_legacy';
    await insertAttemptEvent({ attemptId, questionId: 'q_legacy' });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"memory","secondary_categories":[],"ai_analysis_md":"forgot","confidence":0.7}',
    });
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
    });
    const judgeRows = await db.select().from(event).where(eq(event.caused_by_event_id, attemptId));
    // Step 7 removed the Zod bridge; legacy field name fails parse, no judge event written.
    expect(judgeRows).toHaveLength(0);
  });

  it('swallows runTask error (no judge event written; no throw)', async () => {
    const db = testDb();
    const attemptId = 'attempt_e_err';
    await insertAttemptEvent({ attemptId, questionId: 'q_err' });
    const fakeRunTask = async () => {
      throw new Error('LLM down');
    };
    await expect(
      runAttributionAndWriteJudgeEvent({
        db,
        attemptEventId: attemptId,
        input: validInput,
        runTaskFn: fakeRunTask,
      }),
    ).resolves.toBeUndefined();
    const rows = await db.select().from(event).where(eq(event.caused_by_event_id, attemptId));
    expect(rows).toHaveLength(0);
    const ledgerRows = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].outcome).toBe('failed_retryable');
  });

  it('swallows parse error (no judge event written)', async () => {
    const db = testDb();
    const attemptId = 'attempt_e_parse';
    await insertAttemptEvent({ attemptId, questionId: 'q_parse' });
    const fakeRunTask = async () => ({ text: '不是 JSON' });
    await expect(
      runAttributionAndWriteJudgeEvent({
        db,
        attemptEventId: attemptId,
        input: validInput,
        runTaskFn: fakeRunTask,
      }),
    ).resolves.toBeUndefined();
    const rows = await db.select().from(event).where(eq(event.caused_by_event_id, attemptId));
    expect(rows).toHaveLength(0);
  });

  it('idempotent — calling twice on same attempt does not duplicate judge event', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = testDb();
    const attemptId = 'attempt_e_idem';
    await insertAttemptEvent({ attemptId, questionId: 'q_idem' });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"first","confidence":0.5}',
    });
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
    });
    // Second call must skip with a warn — judge already exists for this attempt.
    const fakeRunTask2 = vi.fn(async () => ({
      text: '{"primary_category":"memory","secondary_categories":[],"analysis_md":"second","confidence":0.6}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask2,
    });
    expect(warnSpy).toHaveBeenCalled();
    const rows = await db.select().from(event).where(eq(event.caused_by_event_id, attemptId));
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as { cause: { analysis_md: string } };
    expect(payload.cause.analysis_md).toBe('first');
    warnSpy.mockRestore();
  });
});
