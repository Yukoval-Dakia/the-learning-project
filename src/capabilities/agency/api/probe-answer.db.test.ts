// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S3) — probe answer route DB test.
//
// Asserts the route's three contracts:
//   1. HAPPY (A5-a outcome→resolution split): judge 'incorrect' → outcome=0 →
//      'confirmed' + probe_result event; judge 'correct' → outcome=1 → 'retired'.
//   2. IDEMPOTENCY: re-answer short-circuits via `peekExistingProbeResult` BEFORE
//      invoking the judge (LLM cost guard) — judge NOT called, recorded values
//      returned with coarse_outcome: null.
//   3. FAIL-CLOSED: judge 'unsupported' / 'partial' → 422, NO probe_result written,
//      probe stays active (served-but-unanswered slot not consumed).
// Plus the gating errors: 400 (bad body), 404 (no question), 409 (not a mind_probe).
//
// The judge invoker is mocked (`createDefaultJudgeInvoker` → `invoke`) so the test
// pins coarse_outcome per case and exercises the route's outcome-mapping + write
// logic, NOT the real LLM judge. The mock mirrors how submit.ts / advice.ts tests
// mock the same chokepoint. serveProbeOnce (the producer half, wired in S2) is real,
// so the probe question row is genuine.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { serveProbeOnce } from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { newId } from '@/core/ids';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './probe-answer';

// ── Judge invoker mock ─────────────────────────────────────────────────────────
// vi.hoisted so the fn reference survives vi.mock's factory hoisting. The route
// calls `createDefaultJudgeInvoker().invoke(...)` — we mock the invoker module so
// `invoke` returns a pinned JudgeResultV2T without an LLM call. This is the SAME
// module submit.ts / advice.ts mock in their tests (the invoker is the shared
// judge chokepoint; the base registry's `resolveJudge().run()` is a validation
// stub, NOT a runtime judge — review PR #705 CRITICAL).
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock('@/server/judge/invoker', () => ({
  createDefaultJudgeInvoker: () => ({ invoke: mockInvoke }),
}));

const KC_ID = 'kn_chain_rule';
const PROBE_RESULT_ACTION = 'experimental:probe_result';

function judgeResult(coarse_outcome: 'correct' | 'incorrect' | 'partial' | 'unsupported') {
  // Minimal JudgeResultV2T shape — the route only reads coarse_outcome.
  const base = {
    score_meaning: 'percentage' as const,
    confidence: 0.9,
    capability_ref: { id: 'mock', version: 'mock_v1' },
    feedback_md: 'mock',
    evidence_json: {} as Record<string, unknown>,
  };
  if (coarse_outcome === 'correct') return { ...base, coarse_outcome, score: 0.95 };
  if (coarse_outcome === 'partial') return { ...base, coarse_outcome, score: 0.5 };
  if (coarse_outcome === 'incorrect') return { ...base, coarse_outcome, score: 0 };
  return { ...base, coarse_outcome, score: null, confidence: 0, feedback_md: 'unsupported' };
}

// Invoker returns `{ result, telemetry }` — only `result` is read by the route.
function invokeResult(coarse_outcome: 'correct' | 'incorrect' | 'partial' | 'unsupported') {
  return { result: judgeResult(coarse_outcome), telemetry: { route: 'semantic' } };
}

async function seedKnowledge(): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db
    .insert(knowledge)
    .values({ id: KC_ID, name: 'chain rule', created_at: now, updated_at: now })
    .onConflictDoNothing();
}

async function seedConjecture(): Promise<string> {
  return writeAiProposal(testDb(), {
    actor_ref: 'research_meeting',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: KC_ID },
      reason_md: 'recurrent cause×KC failure cell',
      evidence_refs: [{ kind: 'event', id: 'evt_a' }],
      cooldown_key: `conjecture:${KC_ID}`,
      proposed_change: {
        claim_md: 'you treat the chain rule as multiplying derivatives',
        knowledge_id: KC_ID,
        cause_category: 'concept_misunderstanding',
        confidence: 0.7,
        recurrence_count: 2,
        probe_md: 'd/dx sin(x^2) = ?',
        probe_reference_md: '2x·cos(x^2) — outer cos × inner 2x (chain rule).',
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
}

async function serveProbe(): Promise<string> {
  const proposalId = await seedConjecture();
  const served = await serveProbeOnce({
    db: testDb(),
    conjectureProposalId: proposalId,
    knowledgeId: KC_ID,
    probeMd: 'd/dx sin(x^2) = ?',
    referenceMd: '2x·cos(x^2)',
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
  return served.probe_question_id;
}

async function answer(probeQuestionId: string, answer_md: string): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/conjecture/probe/${probeQuestionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer_md }),
      headers: { 'content-type': 'application/json' },
    }),
    { id: probeQuestionId },
  );
}

async function probeResultEvents(probeQuestionId: string) {
  return testDb()
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, PROBE_RESULT_ACTION),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, probeQuestionId),
      ),
    );
}

async function fsrsRowCount(): Promise<number> {
  const rows = await testDb().select().from(material_fsrs_state);
  return rows.length;
}

describe('POST /api/conjecture/probe/:id/answer (conjecture-wire #13)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedKnowledge();
    mockInvoke.mockReset();
  });

  it('judge incorrect → outcome=0 → confirmed + ONE probe_result event, no FSRS (ND-5)', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const res = await answer(probeId, 'cos(x^2)');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'confirmed',
      outcome: 0,
      resolution: 'confirmed',
      coarse_outcome: 'incorrect',
      idempotent: false,
    });

    const events = await probeResultEvents(probeId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      outcome: 0,
      resolution: 'confirmed',
      answer_md: 'cos(x^2)',
    });
    // ND-5 red line — probe answer NEVER enrolls / writes FSRS.
    expect(await fsrsRowCount()).toBe(0);
    // Invoker received the owner's answer verbatim via the standard chokepoint.
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.objectContaining({ id: probeId }),
        answer_md: 'cos(x^2)',
      }),
    );
  });

  it('judge correct → outcome=1 → retired (conjecture falsified)', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('correct'));

    const res = await answer(probeId, '2x·cos(x^2)');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'retired',
      outcome: 1,
      resolution: 'retired',
      coarse_outcome: 'correct',
    });

    const events = await probeResultEvents(probeId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ outcome: 1, resolution: 'retired' });
  });

  it('re-answer short-circuits via peek — judge NOT invoked, recorded values win, coarse_outcome null', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const first = await answer(probeId, 'cos(x^2)');
    expect(first.status).toBe(200);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Second answer — peek finds the existing probe_result and short-circuits
    // BEFORE invoking the judge. The recorded resolution (confirmed) wins; the
    // judge is NOT called again (LLM cost guard). coarse_outcome is null because
    // this call did not judge.
    mockInvoke.mockClear();
    const second = await answer(probeId, '2x·cos(x^2)');

    expect(second.status).toBe(200);
    const body = await resJson(second);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(body.idempotent).toBe(true);
    expect(body.coarse_outcome).toBeNull();
    // Recorded resolution is faithfully reported, NOT rewritten by this request.
    expect(body.status).toBe('confirmed');
    expect(body.resolution).toBe('confirmed');
    expect(body.outcome).toBe(0);

    const events = await probeResultEvents(probeId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ resolution: 'confirmed', outcome: 0 });
  });

  it('judge unsupported → 422 fail-closed, NO probe_result written, probe stays active', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('unsupported'));

    const res = await answer(probeId, 'something');
    expect(res.status).toBe(422);

    // No probe_result → the probe slot is NOT consumed (still served-but-unanswered).
    expect(await probeResultEvents(probeId)).toHaveLength(0);
    const [row] = await testDb().select().from(question).where(eq(question.id, probeId)).limit(1);
    expect(row.draft_status).toBe('draft');
    expect(await fsrsRowCount()).toBe(0);
  });

  it('judge partial → 422 fail-closed (ambiguous outcome does not discriminate)', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('partial'));

    const res = await answer(probeId, 'x·cos(x^2)');
    expect(res.status).toBe(422);
    expect(await probeResultEvents(probeId)).toHaveLength(0);
  });

  it('404 when the probe question does not exist', async () => {
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));
    const res = await answer(newId(), 'whatever');
    expect(res.status).toBe(404);
    // Judge never reached (404 guard is before the judge call).
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('409 when the question exists but is not a mind_probe', async () => {
    // Seed a regular (non-probe) question and try to answer it via the probe route.
    const now = new Date();
    const regularId = newId();
    await testDb()
      .insert(question)
      .values({
        id: regularId,
        kind: 'short_answer',
        prompt_md: 'ordinary question',
        knowledge_ids: [KC_ID],
        difficulty: 3,
        source: 'soft',
        draft_status: 'active',
        created_at: now,
        updated_at: now,
      });

    mockInvoke.mockResolvedValue(invokeResult('incorrect'));
    const res = await answer(regularId, 'whatever');
    expect(res.status).toBe(409);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('400 when answer_md is missing or empty', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const resMissing = await POST(
      new Request(`http://localhost/api/conjecture/probe/${probeId}/answer`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'content-type': 'application/json' },
      }),
      { id: probeId },
    );
    expect(resMissing.status).toBe(400);

    const resBlank = await answer(probeId, '   ');
    expect(resBlank.status).toBe(400);
    // Judge never reached on a bad body.
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('422 when probe kind is corrupt (early fail-closed before judge LLM cost)', async () => {
    const probeId = await serveProbe();
    // Corrupt the kind to a non-QuestionKind garbage value.
    await testDb()
      .update(question)
      .set({ kind: 'not-a-real-kind' })
      .where(eq(question.id, probeId));

    mockInvoke.mockResolvedValue(invokeResult('incorrect'));
    const res = await answer(probeId, 'whatever');
    expect(res.status).toBe(422);
    // Early kind guard fires BEFORE the judge call (saves LLM cost).
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(await probeResultEvents(probeId)).toHaveLength(0);
  });

  it('422 when judge_kind_override is corrupt (guard checks .success not truthiness — PR #705 CodeRabbit+OCR)', async () => {
    const probeId = await serveProbe();
    // Corrupt the override to a non-JudgeKind garbage value. The DB column is
    // free-form text. The guard MUST check `overrideParsed.success`, NOT
    // `!overrideParsed` (safeParse always returns a truthy result object, so a
    // plain truthiness check is dead code — caught by CodeRabbit + OCR review).
    await testDb()
      .update(question)
      .set({ judge_kind_override: 'not-a-real-judge-kind' })
      .where(eq(question.id, probeId));

    mockInvoke.mockResolvedValue(invokeResult('incorrect'));
    const res = await answer(probeId, 'whatever');
    expect(res.status).toBe(422);
    // Override guard fires BEFORE the judge call (saves LLM cost).
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(await probeResultEvents(probeId)).toHaveLength(0);
  });
});

async function resJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
