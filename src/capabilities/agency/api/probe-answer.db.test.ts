// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S3) — probe answer route DB test.
//
// Asserts the route's three contracts:
//   1. HAPPY (A5-a outcome→resolution split): judge 'incorrect' → outcome=0 →
//      'confirmed' + probe_result event; judge 'correct' → outcome=1 → 'retired'.
//   2. IDEMPOTENCY: re-answer returns the RECORDED result (answerProbe's per-probe
//      advisory lock + existing-event guard).
//   3. FAIL-CLOSED: judge 'unsupported' / 'partial' → 422, NO probe_result written,
//      probe stays active (served-but-unanswered slot not consumed).
// Plus the gating errors: 400 (bad body), 404 (no question), 409 (not a mind_probe).
//
// The judge is mocked (getDefaultRegistry → resolveJudge → run) so the test pins
// coarse_outcome per case and exercises the route's outcome-mapping + write logic,
// NOT the real LLM judge. serveProbeOnce (the producer half, wired in S2) is real,
// so the probe question row is genuine.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { serveProbeOnce } from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { newId } from '@/core/ids';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { writeAiProposal } from '@/server/proposals/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './probe-answer';

// ── Judge mock ──────────────────────────────────────────────────────────────────
// vi.hoisted so the fn reference survives vi.mock's factory hoisting.
const { mockRun } = vi.hoisted(() => ({ mockRun: vi.fn() }));

vi.mock('@/core/capability/judges', () => ({
  // The route only calls resolveJudge → run(); manifest shape is irrelevant to the
  // route logic. defaultJudgeKindForQuestion stays real (pure) and routes
  // short_answer → 'semantic', which this mock registry resolves to the mock runner.
  getDefaultRegistry: () => ({
    resolveJudge: () => ({ manifest: { id: 'mock' }, run: mockRun }),
  }),
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
    mockRun.mockReset();
  });

  it('judge incorrect → outcome=0 → confirmed + ONE probe_result event, no FSRS (ND-5)', async () => {
    const probeId = await serveProbe();
    mockRun.mockResolvedValue(judgeResult('incorrect'));

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
    // Judge received the owner's answer verbatim.
    expect(mockRun).toHaveBeenCalledWith({
      question: expect.objectContaining({ id: probeId }),
      answer: { content: 'cos(x^2)' },
    });
  });

  it('judge correct → outcome=1 → retired (conjecture falsified)', async () => {
    const probeId = await serveProbe();
    mockRun.mockResolvedValue(judgeResult('correct'));

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

  it('re-answer is idempotent — one probe_result event, idempotent:true, recorded resolution wins', async () => {
    const probeId = await serveProbe();
    mockRun.mockResolvedValue(judgeResult('incorrect'));

    const first = await answer(probeId, 'cos(x^2)');
    expect(first.status).toBe(200);
    // Second answer — judge now says 'correct', but the RECORDED resolution (confirmed)
    // must win (answerProbe idempotency: never rewrite what the record says happened).
    mockRun.mockResolvedValue(judgeResult('correct'));
    const second = await answer(probeId, '2x·cos(x^2)');

    expect(second.status).toBe(200);
    const body = await resJson(second);
    expect(body.idempotent).toBe(true);
    // Recorded resolution is faithfully reported, NOT the second request's retire.
    expect(body.status).toBe('confirmed');
    expect(body.resolution).toBe('confirmed');

    const events = await probeResultEvents(probeId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ resolution: 'confirmed', outcome: 0 });
  });

  it('judge unsupported → 422 fail-closed, NO probe_result written, probe stays active', async () => {
    const probeId = await serveProbe();
    mockRun.mockResolvedValue(judgeResult('unsupported'));

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
    mockRun.mockResolvedValue(judgeResult('partial'));

    const res = await answer(probeId, 'x·cos(x^2)');
    expect(res.status).toBe(422);
    expect(await probeResultEvents(probeId)).toHaveLength(0);
  });

  it('404 when the probe question does not exist', async () => {
    mockRun.mockResolvedValue(judgeResult('incorrect'));
    const res = await answer(newId(), 'whatever');
    expect(res.status).toBe(404);
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

    mockRun.mockResolvedValue(judgeResult('incorrect'));
    const res = await answer(regularId, 'whatever');
    expect(res.status).toBe(409);
  });

  it('400 when answer_md is missing or empty', async () => {
    const probeId = await serveProbe();
    mockRun.mockResolvedValue(judgeResult('incorrect'));

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
  });
});

async function resJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
