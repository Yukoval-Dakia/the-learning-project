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
// THE ONE PORT: the Agent SDK startup/query process boundary to the model.
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

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── THE SINGLE REPLACED PORT ────────────────────────────────────────────────────
// `runTask` talks to the model through the execution adapter's
// startup + PreparedExecutionQuery.query. Faking it via `__setPiAdapterForTests` (and
// nothing else) keeps every prompt-building, provider-resolution, parsing, persistence
// and routing decision in production hands, while making the run deterministic + free.
const sdk = vi.hoisted(() => ({
  /** Flattened prompt text handed to the model, in call order. */
  prompts: [] as string[],
  /** Installed per test: prompt text → one SDK terminal result message. */
  respond: null as null | ((prompt: string) => unknown),
}));

import { type RunnerMessage, __setPiAdapterForTests } from '@/server/ai/execution-adapter';

function fakePiAdapter() {
  return {
    id: 'pi' as const,
    startup: async () => ({
      query: (prompt: unknown) =>
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
          yield responder(text) as RunnerMessage;
        })(),
      close: async () => {},
    }),
  };
}

import { z } from 'zod';
import { capabilities } from '@/capabilities';
import { ai_task_runs, event, knowledge, question } from '@/db/schema';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { buildHonoApp } from '../../../../server/app';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { RESEARCH_MEETING_SAMPLES, runResearchMeetingNightly } from './research_meeting_nightly';

const KC_ID = 'kn_word_activation';
const CAUSE = 'concept_confusion';

// A deliberately unique marker so the seam-2 assertion ("the question row's reference_md
// reached the judge") cannot pass by accident on some other字符串 in the payload.
const PROBE_REFERENCE_MD =
  '意动用法：「以…为异」，主语在心里认为宾语「异」。判分金标 GOLD-REF-YUK789-4f21.';
const PROBE_MD = '「渔人甚异之」中的「异」是使动还是意动？请说明你的判断依据。';
const FOLLOWUP_PROBE_MD = '「邑人奇之」中的「奇」是什么用法？请用新的语境说明判断依据。';
const FOLLOWUP_PROBE_REFERENCE_MD =
  '意动用法：「以…为奇」，主语认为宾语「奇」，不是让宾语发生变化。';
const CLAIM_MD = '你把「使动用法」和「意动用法」混为一谈——见到宾语前的活用动词就先当使动。';

/** The hypothesis every self-consistency sample returns (unanimous ⇒ no grouping call). */
const DRAFT = {
  kind: 'proposal',
  claim_md: CLAIM_MD,
  knowledge_id: KC_ID,
  evidence_event_ids: ['att_wy_0', 'att_wy_1', 'att_wy_2'],
  diagnostic_spec: {
    schema_version: 2,
    target_error_rule_md: '把表达主观评价的意动用法解释成让宾语发生变化的使动用法。',
    trigger_conditions_md: '句中活用动词表达主语对宾语的主观看法，且宾语本身未被造成变化。',
    scope_boundary_md: '不覆盖确实表示主语使宾语发生动作或状态变化的使动用法。',
    expected_wrong_answer_signature_md: '把句意解释为“使宾语变得……”，并据此判为使动。',
    causal_direction_required: false,
  },
  cause_category: CAUSE,
  recurrence_count: 3,
};

const PROBE_PACKAGE = {
  primary: {
    schema_version: 2,
    prompt_md: PROBE_MD,
    reference_md: PROBE_REFERENCE_MD,
    expected_target_error_answer_md: '使动；渔人使它变得奇异。',
    elicits_target_error_reason_md: '保留“主观评价被误读为造成变化”的触发条件。',
    context_kind: 'narrative',
    representation_kind: 'natural_language',
    response_mode: 'answer_with_reason',
    gold_response_signature: {
      kind: 'answer_with_reason',
      answer_md: '意动用法',
      required_reason_features_md: ['表达主语对宾语的主观评价'],
    },
    target_error_response_signature: {
      kind: 'answer_with_reason',
      answer_md: '使动用法',
      required_reason_features_md: ['解释为主语使宾语发生变化'],
    },
  },
  followup: {
    schema_version: 2,
    prompt_md: FOLLOWUP_PROBE_MD,
    reference_md: FOLLOWUP_PROBE_REFERENCE_MD,
    expected_target_error_answer_md: '使动；乡里人使它变得奇特。',
    elicits_target_error_reason_md: '换成独立语境和选择形式，仍检验同一个目标错误。',
    context_kind: 'document',
    representation_kind: 'multiple_choice',
    response_mode: 'answer_with_reason',
    gold_response_signature: {
      kind: 'answer_with_reason',
      answer_md: '意动用法',
      required_reason_features_md: ['表达主语对宾语的主观评价'],
    },
    target_error_response_signature: {
      kind: 'answer_with_reason',
      answer_md: '使动用法',
      required_reason_features_md: ['解释为主语使宾语发生变化'],
    },
  },
  predicted_p: 0.25,
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
  probe_signature_match: {
    match: 'target_error',
    explanation_md: '作答明确把主观评价解释为使宾语发生变化，命中声明的目标错误。',
  },
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
  if (prompt.includes('"scoring_unit":')) {
    const start = prompt.indexOf('{"submission_id":');
    const input = z
      .object({
        scoring_unit: z.object({ criterion: z.object({ rule_id: z.string() }) }),
        slot_responses: z.array(z.object({ slot_id: z.string(), text_md: z.string() })),
      })
      .parse(JSON.parse(prompt.slice(start).split('\n')[0]));
    return {
      ...sdkSuccess({
        kind: 'rule',
        rule_id: input.scoring_unit.criterion.rule_id,
        points_awarded: 0,
        confidence: 0.95,
        feedback_md: JUDGE_INCORRECT.feedback_md,
        probe_signature_match: JUDGE_INCORRECT.probe_signature_match,
        evidence_citations: input.slot_responses.map((slot) => ({
          slot_id: slot.slot_id,
          quote: slot.text_md,
        })),
      }),
      total_cost_usd: 0.0001,
    };
  }
  if (prompt.includes('"probe_package":')) {
    return sdkSuccess({
      review: {
        verdict: 'pass',
        failure_codes: [],
        explanation_md: '两题保留同一触发条件，并使用不同情境与表征。',
      },
    });
  }
  if (prompt.includes('"generation_attempt":')) {
    return sdkSuccess({ package: PROBE_PACKAGE });
  }
  if (prompt.includes('"evidence_cells"')) return sdkSuccess(DRAFT);
  if (prompt.includes('"hypotheses"')) return sdkSuccess({ groups: [[0, 1, 2]] });
  if (prompt.includes('"student_final_answer_text"') || prompt.includes('"prompt_md"')) {
    return sdkSuccess(JUDGE_INCORRECT);
  }
  throw new Error(
    `[closed-loop] fake model received an unroutable prompt: ${prompt.slice(0, 200)}`,
  );
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
async function seedRecurringFailures(
  count = 3,
  options: {
    prefix?: string;
    createdAt?: (index: number) => Date;
  } = {},
): Promise<string[]> {
  const db = testDb();
  const attemptIds: string[] = [];
  const prefix = options.prefix ?? 'wy';
  for (let i = 0; i < count; i += 1) {
    const attemptId = `att_${prefix}_${i}`;
    const questionId = `q_${prefix}_${i}`;
    const createdAt =
      options.createdAt?.(i) ?? new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000);
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
    __setPiAdapterForTests(fakePiAdapter());
  });

  afterEach(() => {
    __setPiAdapterForTests(undefined);
    sdk.respond = null;
    vi.unstubAllEnvs();
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
});
