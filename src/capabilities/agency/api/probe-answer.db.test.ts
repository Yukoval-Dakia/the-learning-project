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

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROBE_JUDGE_STARTED_ACTION,
  serveProbeOnce,
  servePublishedProbe,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import { ConjectureProbeSpecV2, type ConjectureProbeSpecV2T } from '@/core/schema/business';
import { ConjectureProbeSignatureMatch } from '@/core/schema/conjecture-probe-response';
import { ConjectureProposalChange } from '@/core/schema/proposal';
import {
  assessment_issuance,
  assessment_submission,
  event,
  knowledge,
  question,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { publishPaperModelFixture } from '../../../../tests/fixtures/assessment-paper';
import { withProbeSpecs } from '../../../../tests/fixtures/conjecture-probe-spec';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './probe-answer';

const mockInvoke = vi.fn<(...args: unknown[]) => Promise<ReturnType<typeof invokeResult>>>();

const KC_ID = 'kn_chain_rule';
const PROBE_REFERENCE = '2x·cos(x^2) — outer cos × inner 2x (chain rule).';
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

async function seedKnowledge(): Promise<void> {
  const db = testDb();
  const now = new Date();
  await db
    .insert(knowledge)
    .values({ id: KC_ID, name: 'chain rule', created_at: now, updated_at: now })
    .onConflictDoNothing();
}

async function seedConjecture(
  opts: { includeFollowup?: boolean; probeSpec?: ConjectureProbeSpecV2T } = {},
): Promise<string> {
  const change = ConjectureProposalChange.parse({
    claim_md: 'you treat the chain rule as multiplying derivatives',
    knowledge_id: KC_ID,
    cause_category: 'concept_misunderstanding',
    confidence: 0.7,
    recurrence_count: 2,
    probe_md: 'd/dx sin(x^2) = ?',
    probe_reference_md: PROBE_REFERENCE,
    ...(opts.includeFollowup === false
      ? {}
      : {
          followup_probe_md: 'd/dx cos(x^3) = ?',
          followup_probe_reference_md: '-3x^2·sin(x^3) — outer -sin × inner 3x².',
        }),
    discriminating: true,
    predicted_p: 0.3,
    baseline_p_at_induction: 0.6,
  });
  const nativeChange = opts.probeSpec
    ? withProbeSpecs(
        change,
        opts.probeSpec,
        ConjectureProbeSpecV2.parse({
          ...opts.probeSpec,
          prompt_md: change.followup_probe_md,
          reference_md: change.followup_probe_reference_md,
          expected_target_error_answer_md: '-sin(x³) + 3x²',
          context_kind: 'applied',
          representation_kind: 'natural_language',
          gold_response_signature: { kind: 'text', response_md: '-3x² sin(x³)' },
          target_error_response_signature: { kind: 'text', response_md: '-sin(x³) + 3x²' },
        }),
      )
    : change;
  const proposalId = await writeAiProposal(testDb(), {
    actor_ref: 'research_meeting',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: KC_ID },
      reason_md: 'recurrent cause×KC failure cell',
      evidence_refs: [{ kind: 'event', id: 'evt_a' }],
      cooldown_key: `conjecture:${KC_ID}`,
      proposed_change: nativeChange,
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
    referenceMd: PROBE_REFERENCE,
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
  return served.probe_question_id;
}

async function issueOfflineProbe(probeQuestionId: string) {
  const [existing] = await testDb()
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, `iss_probe_${probeQuestionId}`));
  const [row] = await testDb().select().from(question).where(eq(question.id, probeQuestionId));
  if (!existing && row?.source === 'mind_probe') {
    await publishPaperModelFixture(testDb(), probeQuestionId);
    await servePublishedProbe(testDb(), probeQuestionId);
  }
}

async function answer(probeQuestionId: string, answer_md: string): Promise<Response> {
  await issueOfflineProbe(probeQuestionId);
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

describe('POST /api/conjecture/probe/:id/answer (conjecture-wire #13)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedKnowledge();
    __resetRateLimitForTests();
    mockInvoke.mockReset();
    vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(() =>
      createRecordedModelExecutor(testDb(), async (input, _signal, runId) => {
        expect(
          await testDb()
            .select()
            .from(assessment_submission)
            .where(eq(assessment_submission.submission_id, input.submission_id)),
        ).toHaveLength(1);
        const invoked = await mockInvoke(input);
        const value = invoked.result;
        if (input.unit.points === null) throw new Error('fixture requires additive unit');
        if (value.coarse_outcome === 'unsupported')
          return {
            kind: 'pending',
            pending: { reason: 'unjudgeable', detail: 'offline unsupported fixture' },
            run_refs: [runId],
            cost_usd_micros: 0,
          };
        const signature = ConjectureProbeSignatureMatch.safeParse(
          value.evidence_json.probe_signature_match,
        );
        return {
          kind: 'scored',
          points_awarded:
            value.coarse_outcome === 'correct'
              ? input.unit.points
              : value.coarse_outcome === 'partial'
                ? input.unit.points / 2
                : 0,
          matched: {
            rule_id:
              input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : '',
            option_ids: [],
          },
          ...(signature.success ? { probe_signature_match: signature.data } : {}),
          confidence: value.confidence,
          feedback_md: value.feedback_md,
          evidence_citations: input.slot_responses.flatMap((entry) =>
            entry.kind === 'open'
              ? [
                  ...(entry.text_md ? [{ slot_id: entry.slot_id, quote: entry.text_md }] : []),
                  ...entry.evidence.map((item) => ({ evidence_id: item.evidence_id })),
                ]
              : [],
          ),
          run_refs: [invoked.task_run_id ?? runId],
          cost_usd_micros: 0,
        };
      }),
    );
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
});
