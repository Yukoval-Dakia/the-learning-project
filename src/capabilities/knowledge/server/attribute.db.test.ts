import { getTaskSystemPrompt } from '@/ai/task-prompts';
import { cost_ledger, event, question } from '@/db/schema';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  type AttributionInput,
  parseAttributionOutput,
  runAttributionAndWriteJudgeEvent,
} from './attribute';
import { K_MAX, K_SMALL, retrieveCauseCandidates } from './attribute-retrieve';

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

  it('accepts math profile time_pressure after cause taxonomy closeout', () => {
    const text =
      '{"primary_category":"time_pressure","secondary_categories":["unit_error","method"],"analysis_md":"限时条件下节奏失衡","confidence":0.5}';
    const out = parseAttributionOutput(text, resolveSubjectProfile('math'));
    expect(out.primary_category).toBe('time_pressure');
    expect(out.secondary_categories).toEqual(['unit_error', 'method']);
    expect(out.analysis_md).toBe('限时条件下节奏失衡');
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

// ── YUK-462: retrieve→rerank stage 1 (retriever) ──────────────────────────────
// Pure, no LLM, no DB. Lives in this file for cohesion with the rerank-path DB
// tests below; executes fine under the db config harness.
describe('retrieveCauseCandidates', () => {
  const retrieveInput: AttributionInput = {
    prompt_md: '"之"在主谓之间的用法?',
    reference_md: '取消句子独立性',
    wrong_answer_md: '助词',
    knowledge_context: [{ id: 'k_xuci', name: '虚词', effective_domain: 'wenyan' }],
  };

  it('returns full vocab verbatim (same reference, no reordering) for small-vocab profiles', () => {
    // EQUIVALENCE CONTRACT: the candidate set handed to stage 2 is byte-identical
    // to what buildAttributionPrompt embeds inline. Every current profile vocab
    // (max 11) is <= K_SMALL (15), so the retriever is an identity passthrough.
    const wenyan = resolveSubjectProfile('wenyan');
    const math = resolveSubjectProfile('math');
    expect(wenyan.causeCategories.length).toBeLessThanOrEqual(K_SMALL);
    expect(math.causeCategories.length).toBeLessThanOrEqual(K_SMALL);
    // Identity (same array reference) — not just deep-equal — proves zero copy/reorder.
    expect(retrieveCauseCandidates(retrieveInput, wenyan)).toBe(wenyan.causeCategories);
    expect(retrieveCauseCandidates(retrieveInput, math)).toBe(math.causeCategories);
  });

  it('large-vocab retriever truncates to <= K_MAX and includes exact keyword matches', () => {
    // Synthetic profile with > K_SMALL categories, one of which substring-matches a
    // token in the input. Marks the large-vocab branch as exercised even though no
    // real profile reaches it today.
    const base = resolveSubjectProfile('wenyan');
    const synthCategories = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      label: i === 7 ? '助词误用' : `占位错因${i}`,
      description: i === 7 ? '把动词误判为助词' : undefined,
    }));
    const synthProfile: SubjectProfile = { ...base, causeCategories: synthCategories };
    const result = retrieveCauseCandidates(retrieveInput, synthProfile);
    expect(result.length).toBeLessThanOrEqual(K_MAX);
    // The exact-keyword match ('助词' appears in wrong_answer_md) must survive truncation.
    expect(result.some((c) => c.id === 'c7')).toBe(true);
  });
});

// ── YUK-462: rerank task prompt (stage 2 system prompt) ───────────────────────
describe('AttributionRerankTask system prompt', () => {
  it('renders the profile taxonomy + the JSON contract tokens', () => {
    const wenyan = resolveSubjectProfile('wenyan');
    const prompt = getTaskSystemPrompt('AttributionRerankTask', wenyan);
    expect(prompt.length).toBeGreaterThan(0);
    // JSON contract tokens (same as buildAttributionPrompt).
    expect(prompt).toContain('primary_category');
    expect(prompt).toContain('analysis_md');
    expect(prompt).toContain('confidence');
    // Taxonomy of the profile is embedded (e.g. the 'grammar' cause id for wenyan).
    expect(prompt).toContain('grammar');
    // Rerank-specific: the prompt must reference the structured candidates field.
    expect(prompt).toContain('candidates');
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

  // ── YUK-462: retrieve→rerank pipeline ───────────────────────────────────────
  // The refactor swaps the single direct-select call for a two-stage
  // retrieve→rerank. For small-vocab profiles (every current one), the retriever
  // is an identity passthrough, so behavior is equivalent to direct-select.

  it('YUK-462: small-vocab rerank output passes through identically to direct-select', async () => {
    // Same JSON the legacy "writes a judge event…" test returns. Proves stage-2
    // output flows through parseAttributionOutput + validateCauseAgainstProfile +
    // writeEvent exactly as before — no change to where/how the cause is written.
    const db = testDb();
    const attemptId = 'attempt_e_rerank_passthrough';
    await insertAttemptEvent({ attemptId, questionId: 'q_rerank_passthrough' });
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
    const payload = judgeRows[0].payload as {
      cause: { primary_category: string; analysis_md: string; confidence: number };
    };
    expect(payload.cause.primary_category).toBe('concept');
    expect(payload.cause.analysis_md).toBe('why');
    expect(payload.cause.confidence).toBe(0.8);
  });

  it('YUK-462: runTaskFn is invoked with kind AttributionRerankTask and candidates == full profile vocab', async () => {
    // EQUIVALENCE: the candidates handed to stage 2 must equal what the old prompt
    // embedded inline (the full profile vocab). The original AttributionInput
    // fields must still flow through untouched.
    const db = testDb();
    const attemptId = 'attempt_e_rerank_kind';
    await insertAttemptEvent({ attemptId, questionId: 'q_rerank_kind' });
    const wenyan = resolveSubjectProfile('wenyan');
    const spy = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"why","confidence":0.8}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: spy,
      subjectProfile: wenyan,
    });
    expect(spy).toHaveBeenCalledOnce();
    const [kind, rerankInput] = spy.mock.calls[0];
    expect(kind).toBe('AttributionRerankTask');
    const typedInput = rerankInput as AttributionInput & { candidates: unknown };
    // candidates == the full profile vocab (== inline taxonomy of the old prompt).
    expect(typedInput.candidates).toEqual(wenyan.causeCategories);
    // Original AttributionInput fields still passed through.
    expect(typedInput.prompt_md).toBe(validInput.prompt_md);
    expect(typedInput.reference_md).toBe(validInput.reference_md);
    expect(typedInput.wrong_answer_md).toBe(validInput.wrong_answer_md);
    expect(typedInput.knowledge_context).toEqual(validInput.knowledge_context);
  });

  it('copies task provenance from AttributionTask onto the judge event', async () => {
    const db = testDb();
    const attemptId = 'attempt_e_provenance';
    await insertAttemptEvent({ attemptId, questionId: 'q_provenance' });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"why","confidence":0.8}',
      task_run_id: 'tr_attr_1',
      cost_usd: 0.0042,
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
    expect(judgeRows[0].task_run_id).toBe('tr_attr_1');
    expect(judgeRows[0].cost_micro_usd).toBe(4200);
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

  // D6 (U4 L-stamp) — attribution is a non-routed judge: it stamps the resolved
  // SubjectProfile.version onto payload.profile_version, but leaves capability_ref
  // / judge_route undefined (no routed judge capability). Use a '2.0.0' profile so
  // the assertion proves the version is actually sourced from the profile (the real
  // profiles are all on '1.0.0' — a same-value check would pass on any path).
  it('stamps profile_version from the resolved profile; capability_ref/judge_route stay absent', async () => {
    const db = testDb();
    const attemptId = 'attempt_e_pv';
    await insertAttemptEvent({ attemptId, questionId: 'q_pv' });
    const fakeRunTask = async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"why","confidence":0.8}',
    });
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
      subjectProfile: { ...resolveSubjectProfile('wenyan'), version: '2.0.0' },
    });
    const judgeRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(judgeRows).toHaveLength(1);
    const payload = judgeRows[0].payload as {
      profile_version?: string;
      capability_ref?: unknown;
      judge_route?: unknown;
    };
    expect(payload.profile_version).toBe('2.0.0');
    expect(payload.capability_ref).toBeUndefined();
    expect(payload.judge_route).toBeUndefined();
  });

  it('defaults profile_version to the default profile when no subjectProfile passed', async () => {
    const db = testDb();
    const attemptId = 'attempt_e_pv_default';
    await insertAttemptEvent({ attemptId, questionId: 'q_pv_default' });
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
    const payload = judgeRows[0].payload as { profile_version?: string };
    // default profile (wenyan) version — present (not undefined) on the event.
    expect(payload.profile_version).toBe(resolveSubjectProfile(null).version);
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

  // ── round-4 fix #4: attribution_pending gate ──────────────────────────────

  it('round-4 fix #4: paper placeholder judge (attribution_pending=true) does NOT block attribution', async () => {
    // Simulate: paper-submit wrote a judge event with attribution_pending=true.
    // Attribution should proceed (LLM called) and write a real judge event.
    const db = testDb();
    const attemptId = 'attempt_e_pending';
    await insertAttemptEvent({ attemptId, questionId: 'q_pending' });

    // Insert a paper placeholder judge event with attribution_pending=true.
    const now = new Date();
    await db.insert(event).values({
      id: 'judge_placeholder',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'paper_judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'other',
          secondary_categories: [],
          analysis_md: '<paper-submit, attribution deferred>',
          confidence: 0,
        },
        referenced_knowledge_ids: [],
        coarse_outcome: 'incorrect',
        attribution_pending: true,
      },
      caused_by_event_id: attemptId,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    const invokeSpy = vi.fn(async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"real cause","confidence":0.9}',
    }));

    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: invokeSpy,
    });

    // LLM must have been called (placeholder did not block).
    expect(invokeSpy).toHaveBeenCalledOnce();

    // A real attribution judge event was written (now 2 judge events chained).
    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(rows).toHaveLength(2);

    // The newest judge (by created_at) carries the real cause.
    const newest = rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    const payload = newest?.payload as { cause: { primary_category: string; analysis_md: string } };
    expect(payload.cause.primary_category).toBe('concept');
    expect(payload.cause.analysis_md).toBe('real cause');
  });

  it('round-4 fix #4: real attribution judge (no attribution_pending) IS idempotent — blocks second run', async () => {
    // Once a real attribution judge exists (attribution_pending absent/false),
    // a second call must skip and not invoke the LLM again.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = testDb();
    const attemptId = 'attempt_e_real';
    await insertAttemptEvent({ attemptId, questionId: 'q_real' });

    const fakeRunTask = async () => ({
      text: '{"primary_category":"reading","secondary_categories":[],"analysis_md":"real","confidence":0.75}',
    });
    // First call — writes real judge (no attribution_pending).
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
    });

    // Second call — real judge already exists, must skip.
    const secondSpy = vi.fn(async () => ({
      text: '{"primary_category":"memory","secondary_categories":[],"analysis_md":"should not write","confidence":0.5}',
    }));
    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: secondSpy,
    });

    expect(secondSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(rows).toHaveLength(1);
    warnSpy.mockRestore();
  });

  // ── round-6 fix #1 (CR 3359820520): attribution judge inherits visibility ──

  it('round-6 fix #1: attribution judge inherits visible_to_user:false from paper placeholder', async () => {
    // When the paper placeholder carries visible_to_user:false (feedback buffered
    // until session completes), the attribution judge must inherit that flag so
    // the newest-wins read layer does not treat absent visible_to_user as visible
    // and prematurely expose buffered feedback.
    const db = testDb();
    const attemptId = 'attempt_e_r6_vis';
    await insertAttemptEvent({ attemptId, questionId: 'q_r6_vis' });

    const now = new Date();
    await db.insert(event).values({
      id: 'judge_placeholder_r6',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'paper_judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'other',
          secondary_categories: [],
          analysis_md: '<paper-submit, attribution deferred>',
          confidence: 0,
        },
        referenced_knowledge_ids: [],
        coarse_outcome: 'incorrect',
        score: 0,
        visible_to_user: false,
        attribution_pending: true,
      },
      caused_by_event_id: attemptId,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    const fakeRunTask = async () => ({
      text: '{"primary_category":"concept","secondary_categories":[],"analysis_md":"real cause","confidence":0.9}',
    });

    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
    });

    // Two judge events — the placeholder and the real attribution.
    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    expect(rows).toHaveLength(2);

    // The newest judge (the attribution) must inherit visible_to_user:false.
    const newest = rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    const payload = newest?.payload as {
      visible_to_user?: boolean;
      coarse_outcome?: string;
      score?: number;
      attribution_pending?: boolean;
    };
    expect(payload.visible_to_user).toBe(false); // inherited from placeholder
    expect(payload.coarse_outcome).toBe('incorrect'); // inherited from placeholder
    expect(payload.score).toBe(0); // inherited from placeholder
    // attribution_pending must NOT be inherited (attribution is done).
    expect(payload.attribution_pending).toBeUndefined();
  });

  it('round-6 fix #1: attribution judge without placeholder visibility has no visible_to_user override', async () => {
    // When the placeholder does NOT set visible_to_user (immediate feedback policy),
    // the attribution judge must not inject a false override — it should be absent
    // so the read layer treats it as visible (default).
    const db = testDb();
    const attemptId = 'attempt_e_r6_vis_none';
    await insertAttemptEvent({ attemptId, questionId: 'q_r6_vis_none' });

    const now = new Date();
    await db.insert(event).values({
      id: 'judge_placeholder_r6_none',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'paper_judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'other',
          secondary_categories: [],
          analysis_md: '<paper-submit, attribution deferred>',
          confidence: 0,
        },
        referenced_knowledge_ids: [],
        coarse_outcome: 'correct',
        // visible_to_user intentionally absent (immediate policy)
        attribution_pending: true,
      },
      caused_by_event_id: attemptId,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    const fakeRunTask = async () => ({
      text: '{"primary_category":"memory","secondary_categories":[],"analysis_md":"reason","confidence":0.7}',
    });

    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: attemptId,
      input: validInput,
      runTaskFn: fakeRunTask,
    });

    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, attemptId)));
    const newest = rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    const payload = newest?.payload as { visible_to_user?: boolean };
    // visible_to_user must be absent (undefined) on the attribution judge — not false.
    expect(payload.visible_to_user).toBeUndefined();
  });
});
