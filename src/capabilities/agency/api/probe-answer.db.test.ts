// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S3) — probe answer route DB test.
//
// Asserts the route's three contracts:
//   1. HAPPY (YUK-787/YUK-827 split): historical probes retain coarse mapping;
//      response-aware probes require gold/target semantic signature agreement.
//   2. IDEMPOTENCY: re-answer short-circuits via `peekExistingProbeResult` BEFORE
//      invoking the judge (LLM cost guard) — judge NOT called, recorded values
//      returned with coarse_outcome: null.
//   3. FAIL-CLOSED: unsupported/partial, ambiguous or missing signature matches,
//      and snapshot drift write NO probe_result. A gradable ordinary wrong answer
//      is terminal non-evidence, so it consumes the probe without strengthening
//      or falsifying the conjecture.
// Plus the gating errors: 400 (bad body), 404 (no question), 409 (not a mind_probe).
//
// The judge invoker is mocked (`createDefaultJudgeInvoker` → `invoke`) so the test
// pins coarse_outcome per case and exercises the route's outcome-mapping + write
// logic, NOT the real LLM judge. The mock mirrors how submit.ts / advice.ts tests
// mock the same chokepoint. serveProbeOnce (the producer half, wired in S2) is real,
// so the probe question row is genuine.

import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROBE_JUDGE_RELEASED_ACTION,
  PROBE_JUDGE_STARTED_ACTION,
  countActiveProbes,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { newId } from '@/core/ids';
import { ConjectureProbeSpecV2 } from '@/core/schema/business';
import {
  ai_task_runs,
  cost_ledger,
  event,
  knowledge,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { writeAiProposal } from '@/server/proposals/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { ProbeAnswerResponseSchema } from './contracts';
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

function judgeResult(
  coarse_outcome: 'correct' | 'incorrect' | 'partial' | 'unsupported',
  probe_signature_match?: {
    match: 'gold' | 'target_error' | 'neither' | 'ambiguous';
    explanation_md: string;
  },
) {
  // Minimal JudgeResultV2T shape — the route only reads coarse_outcome.
  const base = {
    score_meaning: 'percentage' as const,
    confidence: 0.9,
    capability_ref: { id: 'mock', version: 'mock_v1' },
    feedback_md: 'mock',
    evidence_json: {
      ...(probe_signature_match ? { probe_signature_match } : {}),
    } as Record<string, unknown>,
  };
  if (coarse_outcome === 'correct') return { ...base, coarse_outcome, score: 0.95 };
  if (coarse_outcome === 'partial') return { ...base, coarse_outcome, score: 0.5 };
  if (coarse_outcome === 'incorrect') return { ...base, coarse_outcome, score: 0 };
  return { ...base, coarse_outcome, score: null, confidence: 0, feedback_md: 'unsupported' };
}

// The route reads `result` plus the optional authoritative `task_run_id`; telemetry
// is retained so the mock still resembles the production invoker envelope.
function invokeResult(
  coarse_outcome: 'correct' | 'incorrect' | 'partial' | 'unsupported',
  probe_signature_match?: {
    match: 'gold' | 'target_error' | 'neither' | 'ambiguous';
    explanation_md: string;
  },
  taskRunId?: string,
) {
  return {
    result: judgeResult(coarse_outcome, probe_signature_match),
    telemetry: { route: 'multimodal_direct' },
    ...(taskRunId ? { task_run_id: taskRunId } : {}),
  };
}

async function seedJudgeRunWithCost(params: {
  runId: string;
  costId: string;
  inputHash: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  startedAt: Date;
}): Promise<void> {
  const finishedAt = new Date(params.startedAt.getTime() + 1_842);
  await testDb()
    .insert(ai_task_runs)
    .values({
      id: params.runId,
      task_kind: 'MultimodalDirectJudgeTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5',
      input_hash: params.inputHash,
      status: 'success',
      finish_reason: 'stop',
      usage_json: { inputTokens: params.tokensIn, outputTokens: params.tokensOut },
      cost_usd: params.cost,
      started_at: params.startedAt,
      finished_at: finishedAt,
    });
  await testDb().insert(cost_ledger).values({
    id: params.costId,
    task_run_id: params.runId,
    task_kind: 'MultimodalDirectJudgeTask',
    provider: 'xiaomi',
    model: 'mimo-v2.5',
    cost: params.cost,
    currency: 'USD',
    tokens_in: params.tokensIn,
    tokens_out: params.tokensOut,
    outcome: 'success',
    occurred_at: finishedAt,
  });
}

async function seedKnowledge(): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db
    .insert(knowledge)
    .values({ id: KC_ID, name: 'chain rule', created_at: now, updated_at: now })
    .onConflictDoNothing();
}

async function seedConjecture(opts: { includeFollowup?: boolean } = {}): Promise<string> {
  const proposalId = await writeAiProposal(testDb(), {
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
        ...(opts.includeFollowup === false
          ? {}
          : {
              followup_probe_md: 'd/dx cos(x^3) = ?',
              followup_probe_reference_md: '-3x^2·sin(x^3) — outer -sin × inner 3x².',
            }),
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
  await writeEvent(testDb(), {
    id: `rate_${proposalId}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: { rating: 'accept', conjecture_id: proposalId, calibration_anchor: 'accept' },
    caused_by_event_id: proposalId,
  });
  return proposalId;
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

async function serveResponseAwareProbe(): Promise<string> {
  const proposalId = await seedConjecture();
  const probeSpec = ConjectureProbeSpecV2.parse({
    schema_version: 2,
    prompt_md: 'd/dx sin(x^2) = ?',
    reference_md: '2x·cos(x^2)',
    expected_target_error_answer_md: 'cos(x^2)+2x',
    elicits_target_error_reason_md: '区分两层导数相乘与相加。',
    context_kind: 'abstract',
    representation_kind: 'symbolic',
    response_mode: 'short_answer',
    gold_response_signature: { kind: 'text', response_md: '2x·cos(x^2)' },
    target_error_response_signature: {
      kind: 'text',
      response_md: 'cos(x^2)+2x',
    },
  });
  const served = await serveProbeOnce({
    db: testDb(),
    conjectureProposalId: proposalId,
    knowledgeId: KC_ID,
    probeMd: probeSpec.prompt_md,
    referenceMd: probeSpec.reference_md,
    probeSpec,
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

async function answerWithImages(
  probeQuestionId: string,
  answer_md: string,
  answer_image_refs: string[],
): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/conjecture/probe/${probeQuestionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer_md, answer_image_refs }),
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

async function probeLifecycleEvents(probeQuestionId: string, action: string) {
  return testDb()
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, action),
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
    __resetRateLimitForTests();
    mockInvoke.mockReset();
  });

  // YUK-567 slice-2 — probes are served with judge_kind_override='multimodal_direct'
  // (an IMAGE_CONSUMING route), so a photo / photo-only answer is graded (not 422'd)
  // and the student image refs thread through to the judge invoke.
  it('photo-only answer grades via the vision route + threads student images', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('correct'));

    const res = await answerWithImages(probeId, '', ['asset_hand1']);
    expect(res.status).toBe(200); // NOT 422 — multimodal_direct consumes the photo
    const body = ProbeAnswerResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: 'retired', outcome: 1, resolution: 'retired' });
    // the uploaded answer image rode through to the judge as student_image_refs.
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ student_image_refs: ['asset_hand1'] }),
    );
    // Provenance: the photo answer's asset refs are recorded on the probe_result event
    // (not just fed to the judge), so the team can later see what was submitted.
    const events = await probeResultEvents(probeId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ answer_md: '', answer_image_refs: ['asset_hand1'] });
  });

  it('rejects an empty answer (no text AND no image) with 400', async () => {
    const probeId = await serveProbe();
    const res = await answerWithImages(probeId, '', []);
    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('judge incorrect → outcome=0 → evidence_for + ONE probe_result event, no FSRS', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const res = await answer(probeId, 'cos(x^2)');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'evidence_for',
      outcome: 0,
      resolution: 'evidence_for',
      coarse_outcome: 'incorrect',
      idempotent: false,
    });

    const events = await probeResultEvents(probeId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      outcome: 0,
      resolution: 'evidence_for',
      answer_md: 'cos(x^2)',
    });
    const [initialProbe] = await testDb()
      .select({ source_ref: question.source_ref })
      .from(question)
      .where(eq(question.id, probeId));
    const followups = (await testDb().select().from(question)).filter(
      (row) =>
        row.source_ref === initialProbe.source_ref &&
        (row.metadata as Record<string, unknown>).probe_sequence === 2,
    );
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({
      prompt_md: 'd/dx cos(x^3) = ?',
      reference_md: '-3x^2·sin(x^3) — outer -sin × inner 3x².',
      draft_status: 'draft',
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

  it('response-aware probe records target-error evidence only when the declared signature matches', async () => {
    const probeId = await serveResponseAwareProbe();
    mockInvoke.mockResolvedValue(
      invokeResult('incorrect', {
        match: 'target_error',
        explanation_md:
          'The response semantically matches the declared addition-not-composition error.',
      }),
    );

    const response = await answer(probeId, 'cos(x^2)+2x');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'evidence_for',
      outcome: 0,
      answer_result: 'incorrect',
      target_error_match: 'matched',
      gradable: true,
      response_reason_code: 'target_error_signature_matched',
      signature_match_explanation_md: expect.stringContaining('declared addition-not-composition'),
    });
    const [persisted] = await probeResultEvents(probeId);
    expect(persisted.payload).toMatchObject({
      response_judgement: {
        rule_version: 'conjecture_probe_response_signature_v1',
        answer_result: 'incorrect',
        target_error_match: 'matched',
        gradable: true,
        signature_match_explanation_md: expect.stringContaining(
          'declared addition-not-composition',
        ),
      },
    });

    const replay = await answer(probeId, '2x·cos(x^2)');
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      status: 'evidence_for',
      outcome: 0,
      answer_result: 'incorrect',
      target_error_match: 'matched',
      gradable: true,
      idempotent: true,
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('attributes only the answered probe run when an ordinary judge uses the same task kind', async () => {
    const probeId = await serveResponseAwareProbe();
    const probeRunId = 'run_probe_chain_rule_20260801_0758';
    const ordinaryRunId = 'run_review_chain_rule_20260801_0757';
    await seedJudgeRunWithCost({
      runId: probeRunId,
      costId: 'cost_probe_chain_rule_20260801_0758',
      inputHash: '0cc2443fd406a6bd3eb306c448e90691e11e3782a41a3120f0188b8181d145a8',
      cost: 0.00342,
      tokensIn: 1_468,
      tokensOut: 219,
      startedAt: new Date('2026-08-01T07:58:00.000Z'),
    });
    // Same provider/model/task kind as the probe, but this is a normal practice
    // judgement. A task_kind-based report would incorrectly add it to probe spend.
    await seedJudgeRunWithCost({
      runId: ordinaryRunId,
      costId: 'cost_review_chain_rule_20260801_0757',
      inputHash: '37191ae5095b646e671a9607d47b6b8ed657022f866c04e1fc18c67913b8e9a1',
      cost: 0.01128,
      tokensIn: 2_354,
      tokensOut: 487,
      startedAt: new Date('2026-08-01T07:57:00.000Z'),
    });
    mockInvoke.mockResolvedValue(
      invokeResult(
        'incorrect',
        {
          match: 'target_error',
          explanation_md:
            'The learner adds the outer derivative cos(x²) to the inner derivative 2x, exactly matching the authored addition-not-composition signature.',
        },
        probeRunId,
      ),
    );

    const response = await answer(
      probeId,
      '我把复合函数拆成两项相加，所以写成 cos(x²)+2x；外层求导和内层求导各算一项。',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'evidence_for',
      outcome: 0,
      target_error_match: 'matched',
    });
    const [persisted] = await probeResultEvents(probeId);
    expect(persisted.task_run_id).toBe(probeRunId);
    expect(persisted.payload).toMatchObject({
      answer_md: '我把复合函数拆成两项相加，所以写成 cos(x²)+2x；外层求导和内层求导各算一项。',
      response_judgement: {
        target_error_match: 'matched',
        signature_match_explanation_md: expect.stringContaining(
          'addition-not-composition signature',
        ),
      },
    });

    // This is the runbook's production query shape: begin at probe_result, then
    // follow the authoritative run id. LEFT JOIN keeps missing-ledger rows visible;
    // starting from event prevents same-kind ordinary practice spend from leaking in.
    const attributed = (await testDb().execute(sql`
      WITH probe_runs AS (
        SELECT id AS probe_result_event_id,
               subject_id AS probe_question_id,
               task_run_id,
               created_at AS probe_result_at
        FROM event
        WHERE action = ${PROBE_RESULT_ACTION}
          AND subject_kind = 'question'
      )
      SELECT p.probe_question_id,
             p.probe_result_event_id,
             p.task_run_id,
             r.status AS run_status,
             c.task_kind,
             c.provider,
             c.model,
             c.currency,
             COUNT(c.id)::int AS ledger_rows,
             ARRAY_REMOVE(ARRAY_AGG(c.id ORDER BY c.occurred_at, c.id), NULL) AS ledger_ids,
             COALESCE(SUM(c.cost), 0)::float8 AS total_cost,
             COALESCE(SUM(c.tokens_in), 0)::bigint AS total_tokens_in,
             COALESCE(SUM(c.tokens_out), 0)::bigint AS total_tokens_out,
             p.probe_result_at
      FROM probe_runs p
      LEFT JOIN ai_task_runs r ON r.id = p.task_run_id
      LEFT JOIN cost_ledger c ON c.task_run_id = p.task_run_id
      GROUP BY p.probe_question_id, p.probe_result_event_id, p.task_run_id,
               r.status, c.task_kind, c.provider, c.model, c.currency, p.probe_result_at
      ORDER BY p.probe_result_at DESC
    `)) as unknown as Array<{
      probe_question_id: string;
      probe_result_event_id: string;
      task_run_id: string;
      run_status: string;
      task_kind: string;
      provider: string;
      model: string;
      currency: string;
      ledger_rows: number;
      ledger_ids: string[];
      total_cost: number;
      total_tokens_in: string | number;
      total_tokens_out: string | number;
    }>;

    expect(attributed).toHaveLength(1);
    expect(attributed[0]).toMatchObject({
      probe_question_id: probeId,
      probe_result_event_id: persisted.id,
      task_run_id: probeRunId,
      run_status: 'success',
      task_kind: 'MultimodalDirectJudgeTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5',
      currency: 'USD',
      ledger_rows: 1,
      ledger_ids: ['cost_probe_chain_rule_20260801_0758'],
    });
    expect(Number(attributed[0].total_cost)).toBeCloseTo(0.00342, 8);
    expect(Number(attributed[0].total_tokens_in)).toBe(1_468);
    expect(Number(attributed[0].total_tokens_out)).toBe(219);
    expect(attributed[0].ledger_ids).not.toContain('cost_review_chain_rule_20260801_0757');
  });

  it('response-aware probe consumes an ordinary wrong answer without writing conjecture evidence', async () => {
    const probeId = await serveResponseAwareProbe();
    mockInvoke.mockResolvedValue(
      invokeResult('incorrect', {
        match: 'neither',
        explanation_md: 'The response is wrong for an unrelated differentiation error.',
      }),
    );

    const response = await answer(probeId, '2x+cos(x)');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'inconclusive',
      resolution: 'inconclusive',
      outcome: null,
      answer_result: 'incorrect',
      target_error_match: 'not_matched',
      gradable: true,
      response_reason_code: 'response_matches_neither_signature',
    });
    const [persisted] = await probeResultEvents(probeId);
    expect(persisted.payload).toMatchObject({
      outcome: null,
      resolution: 'inconclusive',
      response_judgement: {
        answer_result: 'incorrect',
        target_error_match: 'not_matched',
        gradable: true,
      },
    });
    expect(await countActiveProbes(testDb())).toBe(0);

    const replay = await answer(probeId, 'try to change the diagnosis');
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      resolution: 'inconclusive',
      outcome: null,
      idempotent: true,
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('response-aware probe retires only when correctness and the gold signature agree', async () => {
    const probeId = await serveResponseAwareProbe();
    mockInvoke.mockResolvedValue(
      invokeResult('correct', {
        match: 'gold',
        explanation_md: 'The response semantically matches the declared correct signature.',
      }),
    );

    const response = await answer(probeId, '2x·cos(x^2)');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'retired',
      outcome: 1,
      answer_result: 'correct',
      target_error_match: 'not_matched',
      gradable: true,
    });
  });

  it('response-aware probe fails closed when the judge omits or cannot distinguish the signature match', async () => {
    const missingProbeId = await serveResponseAwareProbe();
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const missing = await answer(missingProbeId, 'cos(x^2)+2x');
    expect(missing.status).toBe(422);
    await expect(missing.json()).resolves.toMatchObject({
      error: 'probe_response_ungradable',
    });
    expect(await probeResultEvents(missingProbeId)).toHaveLength(0);

    const ambiguousProbeId = await serveResponseAwareProbe();
    mockInvoke.mockResolvedValue(
      invokeResult('incorrect', {
        match: 'ambiguous',
        explanation_md: 'The answer is too terse to distinguish the rules.',
      }),
    );
    const ambiguous = await answer(ambiguousProbeId, 'cos(x^2)+2x');
    expect(ambiguous.status).toBe(422);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: 'probe_response_ungradable',
    });
    expect(await probeResultEvents(ambiguousProbeId)).toHaveLength(0);
  });

  it('response-aware probe refuses an edited question before paying the judge', async () => {
    const probeId = await serveResponseAwareProbe();
    await testDb()
      .update(question)
      .set({
        prompt_md: 'edited after authoring',
        version: 1,
        updated_at: new Date(),
      })
      .where(eq(question.id, probeId));
    mockInvoke.mockResolvedValue(
      invokeResult('incorrect', {
        match: 'target_error',
        explanation_md: 'This must never be consumed for an edited probe.',
      }),
    );

    const response = await answer(probeId, 'cos(x^2)+2x');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'probe_snapshot_changed',
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(await probeResultEvents(probeId)).toHaveLength(0);
  });

  it('rechecks the immutable question snapshot after the paid judge returns', async () => {
    const probeId = await serveResponseAwareProbe();
    let releaseJudge: ((value: ReturnType<typeof invokeResult>) => void) | undefined;
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseJudge = resolve;
        }),
    );

    const pendingResponse = answer(probeId, 'cos(x^2)+2x');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    await testDb()
      .update(question)
      .set({
        prompt_md: 'edited while the semantic judge was running',
        version: 1,
        updated_at: new Date(),
      })
      .where(eq(question.id, probeId));
    releaseJudge?.(
      invokeResult('incorrect', {
        match: 'target_error',
        explanation_md: 'Matches the authored target-error response signature.',
      }),
    );

    const response = await pendingResponse;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'probe_snapshot_changed',
    });
    expect(await probeResultEvents(probeId)).toHaveLength(0);
  });

  it('fails closed when a persisted probe snapshot is malformed', async () => {
    const probeId = await serveResponseAwareProbe();
    const [probe] = await testDb().select().from(question).where(eq(question.id, probeId)).limit(1);
    if (!probe) throw new Error('expected response-aware probe');
    await testDb()
      .update(question)
      .set({
        metadata: {
          ...(probe.metadata as Record<string, unknown>),
          probe_spec: { schema_version: 2, prompt_md: 'missing required fields' },
        },
        updated_at: new Date(),
      })
      .where(eq(question.id, probeId));
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const response = await answer(probeId, 'cos(x^2)+2x');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'probe_snapshot_invalid',
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(await probeResultEvents(probeId)).toHaveLength(0);
  });

  it('settles a historical sequence-1 probe without a follow-up via the terminal legacy rule', async () => {
    const proposalId = await seedConjecture({ includeFollowup: false });
    const served = await serveProbeOnce({
      db: testDb(),
      conjectureProposalId: proposalId,
      knowledgeId: KC_ID,
      probeMd: 'd/dx sin(x^2) = ?',
      referenceMd: '2x·cos(x^2)',
    });
    if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const response = await answer(served.probe_question_id, 'cos(x²)');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'confirmed',
      outcome: 0,
      resolution: 'confirmed',
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [persisted] = await probeResultEvents(served.probe_question_id);
    expect(persisted.payload).not.toHaveProperty('resolution_rule_version');
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

  it('rejects a retracted conjecture before paying the judge', async () => {
    const proposalId = await seedConjecture();
    const served = await serveProbeOnce({
      db: testDb(),
      conjectureProposalId: proposalId,
      knowledgeId: KC_ID,
      probeMd: 'd/dx sin(x^2) = ?',
      referenceMd: '2x·cos(x^2)',
    });
    if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
    await writeEvent(testDb(), {
      id: `correct_${proposalId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'owner retracted before answering',
        affected_refs: [{ kind: 'open_inquiry', id: proposalId }],
      },
      caused_by_event_id: proposalId,
    });
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const response = await answer(served.probe_question_id, 'cos(x^2)');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'probe_conjecture_inactive' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(await probeResultEvents(served.probe_question_id)).toHaveLength(0);
  });

  it('re-answer short-circuits via peek — judge NOT invoked, recorded values win, coarse_outcome null', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));

    const first = await answer(probeId, 'cos(x^2)');
    expect(first.status).toBe(200);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Second answer — peek finds the existing probe_result and short-circuits
    // BEFORE invoking the judge. The recorded resolution (evidence_for) wins; the
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
    expect(body.status).toBe('evidence_for');
    expect(body.resolution).toBe('evidence_for');
    expect(body.outcome).toBe(0);

    const events = await probeResultEvents(probeId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ resolution: 'evidence_for', outcome: 0 });
  });

  it('persists a per-probe claim before judging so concurrent answers pay at most once', async () => {
    const probeId = await serveProbe();
    let releaseJudge: ((value: ReturnType<typeof invokeResult>) => void) | undefined;
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseJudge = resolve;
        }),
    );

    const firstPromise = answer(probeId, 'cos(x^2)');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));

    const concurrent = await answer(probeId, '2x·cos(x^2)');
    expect(concurrent.status).toBe(409);
    expect(concurrent.headers.get('Retry-After')).toBeTruthy();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const claims = await probeLifecycleEvents(probeId, PROBE_JUDGE_STARTED_ACTION);
    expect(claims).toHaveLength(1);
    expect(claims[0].ingest_at).not.toBeNull();

    releaseJudge?.(invokeResult('incorrect'));
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(await probeResultEvents(probeId)).toHaveLength(1);
  });

  it('judge unsupported → 422 fail-closed, NO probe_result written, probe stays active', async () => {
    const probeId = await serveProbe();
    mockInvoke.mockResolvedValue(invokeResult('unsupported'));

    const res = await answer(probeId, 'something');
    expect(res.status).toBe(422);

    const releases = await probeLifecycleEvents(probeId, PROBE_JUDGE_RELEASED_ACTION);
    expect(releases).toHaveLength(1);
    expect(releases[0].ingest_at).not.toBeNull();

    // No probe_result → the probe slot is NOT consumed (still served-but-unanswered).
    expect(await probeResultEvents(probeId)).toHaveLength(0);
    const [row] = await testDb().select().from(question).where(eq(question.id, probeId)).limit(1);
    expect(row.draft_status).toBe('draft');
    expect(await fsrsRowCount()).toBe(0);

    // The failed paid claim is released immediately; a corrected retry does not
    // wait for the five-minute stale-claim TTL.
    mockInvoke.mockResolvedValue(invokeResult('incorrect'));
    const retry = await answer(probeId, 'corrected answer');
    expect(retry.status).toBe(200);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
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
  return ProbeAnswerResponseSchema.parse(await res.json());
}
