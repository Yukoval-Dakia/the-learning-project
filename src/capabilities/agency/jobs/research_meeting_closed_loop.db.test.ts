// YUK-789 — 闭环回归保护：nightly → brief(proposal) → accept → probe → 真 judge → reconcile
// 的**全链** DB 测试。
//
// WHY THIS FILE EXISTS (the regression it locks):
// The chain was previously covered by three OVERLAPPING partial tests, none of which held
// both ends real at once:
//   - research_meeting_nightly.unit.test.ts stubs all 8 deps (`{} as never` for Db);
//   - teaching-brief.db.test.ts seeds via writeAiProposal directly (no nightly, no reconcile);
//   - reconcile.db.test.ts bypasses nightly AND the HTTP route;
//   - probe-answer.db.test.ts `vi.mock`s `createDefaultJudgeInvoker` — i.e. it mocks the exact
//     chokepoint where review PR #705 found a CRITICAL: production was a stub that always
//     returned coarse_outcome='unsupported' while the test double returned a structurally
//     complete result. Everything was green and production was completely dead.
// The failure MODE is "the test double is more complete than the production implementation".
// The only way to see it is to keep every production seam real and replace exactly ONE port.
//
// THE ONE PORT: `@anthropic-ai/claude-agent-sdk`'s `query` (the process boundary to the model).
// Everything downstream of it is production code: runTask (provider resolution, ai_task_runs +
// cost_ledger writes, structured-output dispatch), induceConjecture's self-consistency,
// writeAiProposal, acceptConjectureProposal, serveProbeOnce, the probe-answer HTTP route,
// createDefaultJudgeInvoker → resolveQuestionJudgeRoute → runMultimodalDirectJudge,
// answerProbe, and reconcileConjecturePredictions.
//
// THREE SEAM ASSERTIONS (the joints that partial tests could never see):
//   S1 the nightly proposal payload SHAPE is the one `acceptConjectureProposal` reads
//      (probe_md / probe_reference_md / knowledge_id land on the served question row);
//   S2 the question row's `reference_md` is what the REAL judge consumes (it appears in the
//      payload handed to the model port), and `judge_kind_override` resolves to a real route
//      (`MultimodalDirectJudgeTask` shows up in ai_task_runs);
//   S3 the `experimental:probe_result` written by the route is what reconcile consumes
//      (`experimental:prediction_score` lands + the typed ledger advances).
//
// RED/GREEN CONTRACT (YUK-789 acceptance #1): breaking any one seam in production code MUST
// turn this file red. Verified by cutting `serveProbeOnce`'s referenceMd (S1/S2 fail) and by
// making `mapOutcome` return null (S3 fails). A closed-loop E2E that cannot go red is just
// another silently-passing test — exactly what this ticket exists to eliminate.

import { and, eq, or, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── THE SINGLE REPLACED PORT ────────────────────────────────────────────────────
// `runTask` talks to the model through `query()` from the Agent SDK. Faking it (and
// nothing else) keeps every prompt-building, provider-resolution, parsing, persistence
// and routing decision in production hands, while making the run deterministic + free.
const sdk = vi.hoisted(() => ({
  /** Flattened prompt text handed to the model, in call order. */
  prompts: [] as string[],
  /** Installed per test: prompt text → one SDK terminal result message. */
  respond: null as null | ((prompt: string) => unknown),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: unknown }) =>
    (async function* () {
      // `promptFromInput` hands a plain string for text tasks and an async iterable of
      // SDKUserMessage for multimodal ones (the vision judge). Flatten both to the text
      // the model would actually read — that is what the seam assertions inspect.
      let text = '';
      if (typeof prompt === 'string') {
        text = prompt;
      } else {
        const iterable = prompt as AsyncIterable<{
          message: { content: Array<{ type: string; text?: string }> };
        }>;
        for await (const msg of iterable) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') text += block.text;
          }
        }
      }
      sdk.prompts.push(text);
      const responder = sdk.respond;
      if (!responder) throw new Error('[closed-loop] no fake model installed for this test');
      yield responder(text);
    })(),
  createSdkMcpServer: () => ({ type: 'sdk', name: '', instance: {} }),
  tool: (name: string, description: string) => ({ name, description }),
}));

import { capabilities } from '@/capabilities';
import { PROBE_QUESTION_SOURCE } from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { ai_task_runs, cost_ledger, event, kc_typed_state, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { PREDICTION_SCORE_ACTION } from '@/server/conjectures/reconcile';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { buildHonoApp } from '../../../../server/app';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { RESEARCH_MEETING_SAMPLES, runResearchMeetingNightly } from './research_meeting_nightly';

const KC_ID = 'kn_word_activation';
const CAUSE = 'concept_confusion';
const PROBE_RESULT_ACTION = 'experimental:probe_result';

// A deliberately unique marker so the seam-2 assertion ("the question row's reference_md
// reached the judge") cannot pass by accident on some other字符串 in the payload.
const PROBE_REFERENCE_MD =
  '意动用法：「以…为异」，主语在心里认为宾语「异」。判分金标 GOLD-REF-YUK789-4f21.';
const PROBE_MD = '「渔人甚异之」中的「异」是使动还是意动？请说明你的判断依据。';
const FOLLOWUP_PROBE_MD = '「邑人奇之」中的「奇」是什么用法？请用新的语境说明判断依据。';
const FOLLOWUP_PROBE_REFERENCE_MD =
  '意动用法：「以…为奇」，主语认为宾语「奇」，不是让宾语发生变化。';
const CLAIM_MD = '你把「使动用法」和「意动用法」混为一谈——见到宾语前的活用动词就先当使动。';

/** The ConjectureDraft every self-consistency sample returns (unanimous ⇒ no dedup call). */
const DRAFT = {
  kind: 'proposal',
  claim_md: CLAIM_MD,
  knowledge_id: KC_ID,
  evidence_event_ids: ['att_wy_0', 'att_wy_1', 'att_wy_2'],
  probe_md: PROBE_MD,
  probe_reference_md: PROBE_REFERENCE_MD,
  followup_probe_md: FOLLOWUP_PROBE_MD,
  followup_probe_reference_md: FOLLOWUP_PROBE_REFERENCE_MD,
  cause_category: CAUSE,
  recurrence_count: 3,
  predicted_p: 0.25,
  discriminating: true,
  agreement_count: 1,
};

/** What the vision judge model returns for a wrong answer (→ preliminary evidence, outcome 0). */
const JUDGE_INCORRECT = {
  coarse_outcome: 'incorrect',
  score: 0,
  feedback_md: '「异」在这里是意动用法，不是使动。',
  evidence: {
    observed_md: '作答按使动解，译成「使之异」。',
    matched_points: [],
    missing_points: ['意动用法'],
  },
  confidence: 0.82,
};

/** Minimal SDK terminal success message carrying the structured output. */
function sdkSuccess(structured: unknown) {
  return {
    type: 'result',
    subtype: 'success',
    result: JSON.stringify(structured),
    stop_reason: 'end_turn',
    total_cost_usd: 0.0012,
    usage: { input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 0 },
    structured_output: structured,
  };
}

/**
 * The fake model. Dispatches on the prompt PRODUCTION built (not on a task-kind flag we
 * invented), so a prompt-shape regression surfaces here as an "unroutable prompt" throw
 * rather than as a silently-correct canned answer.
 */
function fakeModel(prompt: string): unknown {
  if (prompt.includes('"evidence_cells"')) return sdkSuccess(DRAFT);
  if (prompt.includes('"claims"')) return sdkSuccess({ groups: [[0, 1, 2]] });
  if (prompt.includes('"student_final_answer_text"') || prompt.includes('"prompt_md"')) {
    return sdkSuccess(JUDGE_INCORRECT);
  }
  throw new Error(
    `[closed-loop] fake model received an unroutable prompt: ${prompt.slice(0, 200)}`,
  );
}

/** The prompt the vision judge sent to the model (exactly one per run). */
function judgePrompts(): string[] {
  return sdk.prompts.filter((p) => p.includes('"student_final_answer_text"'));
}

async function seedKnowledge(): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({ id: KC_ID, name: '词类活用', created_at: now, updated_at: now })
    .onConflictDoNothing();
}

/**
 * Seed ONE recurring (cause × KC) failure cell through the real event vocabulary:
 * attempt(outcome=failure) + chained judge carrying the cause. `gatherConjectureEvidence`
 * fans out over the ATTEMPT payload's referenced_knowledge_ids, so they must live there.
 * Three distinct attempts ⇒ recurrence_count 3 (floor is 2).
 */
async function seedRecurringFailures(count = 3): Promise<string[]> {
  const db = testDb();
  const attemptIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const attemptId = `att_wy_${i}`;
    const questionId = `q_wy_${i}`;
    const createdAt = new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000);
    attemptIds.push(attemptId);
    await db.insert(question).values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: `解释第 ${i + 1} 句中的活用`,
      reference_md: '意动',
      knowledge_ids: [KC_ID],
      difficulty: 3,
      source: 'manual',
      draft_status: 'active',
      created_at: createdAt,
      updated_at: createdAt,
    });
    await db.insert(event).values({
      id: attemptId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'failure',
      payload: {
        answer_md: '使动',
        answer_image_refs: [],
        referenced_knowledge_ids: [KC_ID],
      },
      created_at: createdAt,
    });
    await db.insert(event).values({
      id: `judge_${attemptId}`,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: CAUSE,
          secondary_categories: [],
          analysis_md: '把意动误判成使动。',
          confidence: 0.9,
        },
        referenced_knowledge_ids: [KC_ID],
      },
      caused_by_event_id: attemptId,
      created_at: new Date(createdAt.getTime() + 500),
    });
  }
  return attemptIds;
}

async function taskKindCounts(): Promise<Record<string, number>> {
  const rows = await testDb().select({ kind: ai_task_runs.task_kind }).from(ai_task_runs);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  return counts;
}

// Both HTTP hops go through the COMPOSITION ROOT, not through a directly-imported
// handler (codex review P1). Importing `POST` from the capability module would keep this
// test green even if the manifest stopped declaring the route or `toHonoPath` mangled the
// `[id]` → `:id` conversion — the same "the seam is not covered" defect this whole file
// exists to prevent — and it would also be a cross-capability deep import, which
// src/capabilities/AGENTS.md forbids (capabilities talk through manifests only).
const INTERNAL_TOKEN = 'closed-loop-test-token';
const app = buildHonoApp(capabilities);

async function apiRequest(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
  });
}

async function answerProbeViaRoute(probeQuestionId: string, answerMd: string): Promise<Response> {
  return apiRequest(`/api/conjecture/probe/${probeQuestionId}/answer`, { answer_md: answerMd });
}

async function acceptViaRoute(proposalId: string): Promise<Response> {
  return apiRequest(`/api/proposals/${proposalId}/decisions`, { decision: 'accept' });
}

describe('closed loop: nightly → proposal → accept → probe → real judge → reconcile (YUK-789)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedKnowledge();
    __resetRateLimitForTests();
    sdk.prompts.length = 0;
    sdk.respond = fakeModel;
    // The induction lane pins provider=anthropic-sub per call; the vision judge stays on
    // the registry mimo default. Both must resolve, so both credentials must be present.
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-test-token');
    vi.stubEnv('XIAOMI_API_KEY', 'sk-test-key');
    vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
    vi.stubEnv('AI_PROVIDER_MODEL', '');
    vi.stubEnv('VISION_JUDGE_PROVIDER', '');
    // The composition root's /api/* middleware compares against this.
    vi.stubEnv('INTERNAL_TOKEN', INTERNAL_TOKEN);
  });

  afterEach(() => {
    sdk.respond = null;
    vi.unstubAllEnvs();
  });

  it('runs the whole chain with only the model port faked and lands prediction_score', async () => {
    const db = testDb();
    const attemptIds = await seedRecurringFailures(3);

    // ── 1. NIGHTLY (real): evidence → induction (real self-consistency) → proposal ──
    const firstRun = await runResearchMeetingNightly(db);
    expect(firstRun.considered).toBe(1);
    expect(firstRun.conjectures_created).toBe(1);
    // YUK-779 counter: a swallowed per-cell throw would still leave conjectures_created
    // plausible-looking on a multi-cell night, so pin the silent-failure count at zero.
    expect(firstRun.cells_failed).toBe(0);
    expect(firstRun.reconciled).toBe(0); // nothing to settle on night one
    expect(firstRun.cost_usd).toBeGreaterThan(0); // real cost accounting, not a stub

    // The induction genuinely ran N samples through the real runner.
    expect(await taskKindCounts()).toMatchObject({
      MindModelInductionTask: RESEARCH_MEETING_SAMPLES,
    });

    const pending = await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' });
    expect(pending).toHaveLength(1);
    const proposal = pending[0];
    if (proposal.payload.kind !== 'conjecture') throw new Error('expected a conjecture proposal');
    const proposalId = proposal.id;
    const change = proposal.payload.proposed_change;

    // The proposal carries the induced draft plus the DETERMINISTIC cell facts.
    expect(change.claim_md).toBe(CLAIM_MD);
    expect(change.probe_md).toBe(PROBE_MD);
    expect(change.probe_reference_md).toBe(PROBE_REFERENCE_MD);
    expect(change.followup_probe_md).toBe(FOLLOWUP_PROBE_MD);
    expect(change.followup_probe_reference_md).toBe(FOLLOWUP_PROBE_REFERENCE_MD);
    expect(change.knowledge_id).toBe(KC_ID);
    expect(change.cause_category).toBe(CAUSE);
    expect(change.recurrence_count).toBe(3);
    expect(change.predicted_p).toBe(DRAFT.predicted_p);
    expect(change.baseline_p_at_induction).toBe(0.5); // cold-start neutral
    expect(proposal.payload.evidence_refs.map((r) => r.id).sort()).toEqual([...attemptIds].sort());

    // ── 2. ACCEPT (real, through the canonical decisions route) ──
    const acceptRes = await acceptViaRoute(proposalId);
    expect(acceptRes.status).toBe(201);

    // ── SEAM 1: the proposal payload SHAPE is what accept read ──
    // Every field below travelled induction → proposal payload → acceptConjectureProposal →
    // serveProbeOnce → question row. A rename/drop anywhere on that path fails here.
    const [probeRow] = await db
      .select()
      .from(question)
      .where(eq(question.source, PROBE_QUESTION_SOURCE))
      .limit(1);
    expect(probeRow, 'accept must serve exactly one probe question').toBeTruthy();
    expect(probeRow.prompt_md).toBe(PROBE_MD);
    expect(probeRow.reference_md).toBe(PROBE_REFERENCE_MD);
    expect(probeRow.knowledge_ids).toEqual([KC_ID]);
    expect(probeRow.draft_status).toBe('draft'); // pool-invisible (U3 invariant #1)
    expect(probeRow.judge_kind_override).toBe('multimodal_direct');
    expect((probeRow.metadata as Record<string, unknown>).conjecture_proposal_id).toBe(proposalId);

    const [rateEvent] = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect((rateEvent.payload as Record<string, unknown>).conjecture_id).toBe(proposalId);

    // ── 3. ANSWER THE PROBE through the real route + the REAL judge invoker ──
    // No `vi.mock('@/server/judge/invoker')` here — this is the chokepoint PR #705 proved
    // can be a dead stub in production while a test double looks complete.
    const answerRes = await answerProbeViaRoute(probeRow.id, '使动用法，译作「使他感到奇异」');
    expect(answerRes.status).toBe(200);
    const answerBody = (await answerRes.json()) as Record<string, unknown>;
    expect(answerBody).toMatchObject({
      status: 'evidence_for',
      resolution: 'evidence_for',
      outcome: 0,
      coarse_outcome: 'incorrect',
      idempotent: false,
    });

    // ── SEAM 2: the question row's reference_md is what the judge consumed ──
    const judgeCalls = judgePrompts();
    expect(judgeCalls, 'exactly one real judge call must have reached the model').toHaveLength(1);
    expect(judgeCalls[0]).toContain(PROBE_REFERENCE_MD);
    expect(judgeCalls[0]).toContain(PROBE_MD);
    expect(judgeCalls[0]).toContain('使动用法，译作「使他感到奇异」');
    // …and `judge_kind_override` resolved to a real, runnable route (not a validation stub).
    expect(await taskKindCounts()).toMatchObject({ MultimodalDirectJudgeTask: 1 });

    const [probeResult] = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, PROBE_RESULT_ACTION),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, probeRow.id),
        ),
      );
    expect(probeResult, 'the judged probe must write exactly one probe_result').toBeTruthy();
    expect(probeResult.payload).toMatchObject({
      conjecture_event_id: proposalId,
      outcome: 0,
      resolution: 'evidence_for',
    });
    const followups = (await db.select().from(question)).filter(
      (row) =>
        row.source_ref === proposalId &&
        (row.metadata as Record<string, unknown>).probe_sequence === 2,
    );
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({
      prompt_md: FOLLOWUP_PROBE_MD,
      reference_md: FOLLOWUP_PROBE_REFERENCE_MD,
      draft_status: 'draft',
    });

    // ── 4. RECONCILE (real) — runs INSIDE the next nightly, as in production ──
    const secondRun = await runResearchMeetingNightly(db);
    expect(secondRun.reconciled).toBe(1);
    expect(secondRun.reconcile_skipped).toBe(0);

    // ── SEAM 3: the probe_result is what reconcile consumed ──
    const scores = await db.select().from(event).where(eq(event.action, PREDICTION_SCORE_ACTION));
    expect(scores).toHaveLength(1);
    expect(scores[0].subject_id).toBe(probeResult.id); // keyed on the probe_result (idempotency anchor)
    expect(scores[0].payload).toMatchObject({
      conjecture_event_id: proposalId,
      probe_result_event_id: probeResult.id,
      knowledge_id: KC_ID,
      predicted_p: DRAFT.predicted_p,
      baseline_p: 0.5,
      outcome: 0,
      resolution: 'evidence_for',
    });

    // The typed ledger advanced off the SAME two events (FLIP-inert soft cell).
    const [cell] = await db
      .select()
      .from(kc_typed_state)
      .where(eq(kc_typed_state.subject_id, KC_ID));
    expect(cell, 'reconcile must advance the typed ledger').toBeTruthy();
    expect(cell.evidence_event_ids).toEqual(expect.arrayContaining([proposalId, probeResult.id]));
  });

  it('re-running reconcile is idempotent — no second prediction_score for the same probe', async () => {
    const db = testDb();
    await seedRecurringFailures(3);

    await runResearchMeetingNightly(db);
    const pending = await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' });
    const proposalId = pending[0].id;
    expect((await acceptViaRoute(proposalId)).status).toBe(201);

    const [probeRow] = await db
      .select()
      .from(question)
      .where(eq(question.source, PROBE_QUESTION_SOURCE))
      .limit(1);
    expect((await answerProbeViaRoute(probeRow.id, '使动')).status).toBe(200);

    const first = await runResearchMeetingNightly(db);
    expect(first.reconciled).toBe(1);
    const second = await runResearchMeetingNightly(db);
    expect(second.reconciled).toBe(0); // already scored ⇒ excluded by the reader

    const scores = await db.select().from(event).where(eq(event.action, PREDICTION_SCORE_ACTION));
    expect(scores).toHaveLength(1);
  });

  it('rolls back trigger, proposal, scan, and completion when the final durable write fails', async () => {
    const db = testDb();
    await seedRecurringFailures(3);

    await expect(
      runResearchMeetingNightly(db, {
        executionId: 'job_atomic_rollback',
        writeEventFn: async (scope, input) => {
          if (input.action === 'experimental:research_meeting_completed') {
            throw new Error('completion persistence failed');
          }
          return writeEvent(scope, input);
        },
      }),
    ).rejects.toThrow('completion persistence failed');

    const rows = await db.select({ action: event.action }).from(event);
    const runActions = rows
      .map((row) => row.action)
      .filter((action) =>
        [
          'experimental:trigger_research_meeting',
          'experimental:proposal',
          'experimental:research_meeting_scan',
          'experimental:research_meeting_completed',
        ].includes(action),
      );
    expect(runActions).toEqual([]);
    expect(await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' })).toHaveLength(
      0,
    );
    const costs = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'MindModelInductionTask'));
    expect(costs).toHaveLength(RESEARCH_MEETING_SAMPLES);
    expect(costs.every((row) => row.cost > 0 && row.outcome === 'success')).toBe(true);
  });

  it('preserves reconciliation counts when the proposal transaction fails and retries', async () => {
    const db = testDb();
    await seedRecurringFailures(3);

    await runResearchMeetingNightly(db);
    const [proposal] = await listProposalInboxRows(db, {
      status: 'pending',
      kind: 'conjecture',
    });
    expect((await acceptViaRoute(proposal.id)).status).toBe(201);
    const [probeRow] = await db
      .select()
      .from(question)
      .where(eq(question.source, PROBE_QUESTION_SOURCE))
      .limit(1);
    expect((await answerProbeViaRoute(probeRow.id, '使动')).status).toBe(200);

    const executionId = 'job_reconcile_then_final_failure';
    await expect(
      runResearchMeetingNightly(db, {
        executionId,
        writeEventFn: async (scope, input) => {
          if (input.action === 'experimental:research_meeting_completed') {
            throw new Error('completion persistence failed');
          }
          return writeEvent(scope, input);
        },
      }),
    ).rejects.toThrow('completion persistence failed');

    const [checkpoint] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:research_meeting_reconciled'),
          sql`${event.payload} ->> 'execution_id' = ${executionId}`,
        ),
      );
    expect(checkpoint.payload).toEqual({
      execution_id: executionId,
      reconcile_result: { reconciled: 1, skipped: 0 },
    });

    const retried = await runResearchMeetingNightly(db, { executionId });
    expect(retried.reconciled).toBe(1);
    const scores = await db.select().from(event).where(eq(event.action, PREDICTION_SCORE_ACTION));
    expect(scores).toHaveLength(1);
    expect(scores[0].payload).toMatchObject({
      research_meeting_execution_id: executionId,
    });
  });

  it('rolls back operational failure ledgers with the run facts', async () => {
    const db = testDb();
    await seedRecurringFailures(3);
    sdk.respond = (prompt) => {
      if (!prompt.includes('"evidence_cells"')) {
        throw new Error(`unexpected task after invalid samples: ${prompt.slice(0, 120)}`);
      }
      return sdkSuccess({ malformed: true });
    };

    await expect(
      runResearchMeetingNightly(db, {
        executionId: 'job_failure_ledger_rollback',
        writeEventFn: async (scope, input) => {
          if (input.action === 'experimental:research_meeting_completed') {
            throw new Error('completion persistence failed');
          }
          return writeEvent(scope, input);
        },
      }),
    ).rejects.toThrow('completion persistence failed');

    const retryableRows = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.outcome, 'failed_retryable'));
    expect(retryableRows).toHaveLength(0);
    const abstainRows = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:conjecture_abstained'));
    expect(abstainRows).toHaveLength(0);
  });

  it('returns the committed summary on same-job redelivery without another model run', async () => {
    const db = testDb();
    await seedRecurringFailures(3);
    const executionId = 'job_committed_redelivery';

    const first = await runResearchMeetingNightly(db, { executionId });
    const taskRunsAfterFirst = await taskKindCounts();
    const second = await runResearchMeetingNightly(db, { executionId });
    const taskRunsAfterSecond = await taskKindCounts();

    expect(second).toEqual(first);
    expect(taskRunsAfterSecond).toEqual(taskRunsAfterFirst);
    expect(await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' })).toHaveLength(
      1,
    );
  });

  it('serializes concurrent deliveries before the completion guard and model work', async () => {
    const db = testDb();
    await seedRecurringFailures(3);
    const executionId = 'job_concurrent_redelivery';
    let knownKeyReads = 0;
    let markFirstReadStarted: (() => void) | undefined;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const loadKnownConjectureKeysFn = async () => {
      knownKeyReads += 1;
      markFirstReadStarted?.();
      await barrier;
      return new Set<string>();
    };

    const firstPromise = runResearchMeetingNightly(db, {
      executionId,
      loadKnownConjectureKeysFn,
    });
    await firstReadStarted;
    const secondPromise = runResearchMeetingNightly(db, {
      executionId,
      loadKnownConjectureKeysFn,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The second delivery is blocked on the execution advisory lock. It has not
    // reached any business read or model call while the first is in-flight.
    expect(knownKeyReads).toBe(1);
    releaseBarrier?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second).toEqual(first);
    expect(first.conjectures_created).toBe(1);
    expect(knownKeyReads).toBe(1);
    expect(await taskKindCounts()).toMatchObject({
      MindModelInductionTask: RESEARCH_MEETING_SAMPLES,
    });
    expect(await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' })).toHaveLength(
      1,
    );
    const proposals = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposals).toEqual([{ id: expect.stringMatching(/^conjecture_proposal_/) }]);
  });

  it('persists an empty completion and ignores evidence that appears before same-job redelivery', async () => {
    const db = testDb();
    const executionId = 'job_empty_redelivery';

    const first = await runResearchMeetingNightly(db, { executionId });
    expect(first).toMatchObject({
      considered: 0,
      conjectures_created: 0,
      trigger_event_id: '',
    });
    expect(await taskKindCounts()).toEqual({});

    // This evidence arrived after the first execution committed. A redelivery of
    // that same pg-boss job must return its original result rather than treating
    // the new rows as unfinished work from the old execution.
    await seedRecurringFailures(3);
    const second = await runResearchMeetingNightly(db, { executionId });

    expect(second).toEqual(first);
    expect(await taskKindCounts()).toEqual({});
    expect(await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' })).toHaveLength(
      0,
    );
    const bookkeeping = await db
      .select({ action: event.action, payload: event.payload })
      .from(event)
      .where(
        or(
          eq(event.action, 'experimental:trigger_research_meeting'),
          eq(event.action, 'experimental:research_meeting_scan'),
          eq(event.action, 'experimental:research_meeting_completed'),
        ),
      );
    expect(bookkeeping).toEqual([
      expect.objectContaining({
        action: 'experimental:research_meeting_completed',
        payload: { completed_result: first },
      }),
    ]);
  });

  it('fails closed before model work when a committed completion payload is unreadable', async () => {
    const db = testDb();
    const executionId = 'job_corrupt_completion';
    await runResearchMeetingNightly(db, { executionId });
    await db
      .update(event)
      .set({ payload: { malformed: true } })
      .where(eq(event.action, 'experimental:research_meeting_completed'));
    await seedRecurringFailures(3);

    await expect(runResearchMeetingNightly(db, { executionId })).rejects.toThrow(
      'research_meeting_nightly: completion payload is unreadable',
    );
    expect(await taskKindCounts()).toEqual({});
    expect(await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' })).toHaveLength(
      0,
    );
  });

  it('persists a real abstain event and creates no conjecture proposal', async () => {
    const db = testDb();
    const attemptIds = await seedRecurringFailures(3);
    sdk.respond = (prompt) => {
      if (!prompt.includes('"evidence_cells"')) {
        throw new Error(`unexpected task after abstain: ${prompt.slice(0, 120)}`);
      }
      return sdkSuccess({
        kind: 'abstain',
        reason_code: 'insufficient_evidence',
        explanation_md: '这些错答不足以区分稳定误解与偶发失误。',
        evidence_event_ids: [attemptIds[0]],
      });
    };

    const result = await runResearchMeetingNightly(db);

    expect(result).toMatchObject({
      considered: 1,
      conjectures_created: 0,
      conjectures_abstained: 1,
      cells_failed: 0,
    });
    expect(await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' })).toHaveLength(
      0,
    );
    const abstainEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:conjecture_abstained'));
    expect(abstainEvents).toHaveLength(1);
    expect(abstainEvents[0]).toMatchObject({
      actor_ref: 'research_meeting',
      subject_kind: 'mind_model',
      subject_id: KC_ID,
      outcome: 'partial',
    });
    expect(abstainEvents[0].payload).toMatchObject({
      reason_code: 'insufficient_evidence',
      evidence_event_ids: [attemptIds[0]],
      requested_samples: RESEARCH_MEETING_SAMPLES,
      votes: { proposal: 0, abstain: 3, invalid: 0, failed: 0 },
    });
  });

  it('attributes malformed semantic grouping to ClaimGroupingTask in the health ledger', async () => {
    const db = testDb();
    await seedRecurringFailures(3);
    let inductionSample = 0;
    sdk.respond = (prompt) => {
      if (prompt.includes('"evidence_cells"')) {
        inductionSample += 1;
        return sdkSuccess({
          ...DRAFT,
          claim_md: `${CLAIM_MD}（表述 ${inductionSample}）`,
        });
      }
      if (prompt.includes('"claims"')) return sdkSuccess({ malformed: true });
      throw new Error(`unexpected task: ${prompt.slice(0, 120)}`);
    };

    const result = await runResearchMeetingNightly(db, {
      executionId: 'job_grouping_attribution',
    });

    expect(result).toMatchObject({
      considered: 1,
      conjectures_created: 0,
      conjectures_abstained: 0,
      cells_failed: 1,
    });
    const failedRows = await db
      .select({ task_kind: cost_ledger.task_kind, outcome: cost_ledger.outcome })
      .from(cost_ledger)
      .where(eq(cost_ledger.outcome, 'failed_retryable'));
    expect(failedRows).toEqual([{ task_kind: 'ClaimGroupingTask', outcome: 'failed_retryable' }]);
  });
});
