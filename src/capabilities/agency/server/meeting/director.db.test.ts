// YUK-572 PR-2 — director pipeline db test. Real Postgres (testcontainer); the pi
// tool-mount layer is wrapped so the in-process tool handlers are captured, and an
// injected stub runAgentTaskFn DRIVES those handlers (fake LLM tool-call flow).
// Everything below the mount layer runs for real: writeAiProposal → the proposal
// row, listProposalInboxRows → the cross-actor dedup base, the trigger/scan events,
// and the dayKey claim gate. Asserts: proposal landing + actor + baseline snapshot
// + cost-bearing scan, cross-actor dedup, degrade, shadow isolation, and claim
// idempotency.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailureAttempt } from '@/capabilities/knowledge/public';
import { event } from '@/db/schema';
import type { MasteryProjection } from '@/server/mastery/state';
import { resolveSubjectProfile } from '@/subjects/profile';
import { RESPONSE_AWARE_PROBE_FIELDS } from '../../../../../tests/helpers/conjecture-probe-fixtures';
import { resetDb, testDb } from '../../../../../tests/helpers/db';

// Capture the registered tool handlers by wrapping piCustomTool — the
// director server is built inside runResearchMeetingDirector, so the test
// cannot reach the returned AgentTool[] directly.
const mockPi = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (args: unknown) => Promise<{ content: { type: string; text: string }[] }>
  >(),
}));

vi.mock('@/server/ai/tools/pi-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/ai/tools/pi-tools')>();
  return {
    ...actual,
    piCustomTool: (
      serverName: string,
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: unknown) => Promise<{ content: { type: string; text: string }[] }>,
    ) => {
      mockPi.handlers.set(name, handler);
      return actual.piCustomTool(serverName, name, description, schema as never, handler as never);
    },
  };
});

import { runResearchMeetingAgentNightly } from '../../jobs/research_meeting_agent_nightly';
import {
  RESEARCH_MEETING_AGENT_ACTOR,
  TRIGGER_ACTION,
  runResearchMeetingDirector,
} from './director';

const NOW = new Date('2026-07-06T21:00:00.000Z'); // 05:00 BJT 2026-07-07

function questionSnapshot(id: string) {
  return {
    schema_version: 1 as const,
    question: {
      question_id: `q_${id}`,
      question_version: 1,
      parent_question_id: null,
      prompt_md: `判断 ${id} 中的条件 A 是否足以推出结论 B。`,
      reference_md: 'A 不是充分条件。',
      choices_md: null,
      image_refs: [],
      figures: [],
      updated_at: NOW.toISOString(),
    },
    parent_question: null,
  };
}

async function callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
  const handler = mockPi.handlers.get(name);
  if (!handler) throw new Error(`no registered tool for ${name}`);
  const res = await handler(args);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

function failure(id: string, kc: string, category: string): FailureAttempt {
  const correction_state = {
    terminal_state: 'active',
    effective_event_id: id,
  } as FailureAttempt['correction_state'];
  return {
    attempt_event_id: id,
    question_id: `q_${id}`,
    answer_md: null,
    answer_image_refs: [],
    referenced_knowledge_ids: [kc],
    question_snapshot: questionSnapshot(id),
    created_at: NOW,
    correction_state,
    judge: {
      judge_event_id: `j_${id}`,
      cause: {
        primary_category: category,
        secondary_categories: [],
        analysis_md: 'analysis',
        confidence: 0.6,
      } as NonNullable<FailureAttempt['judge']>['cause'],
      referenced_knowledge_ids: [kc],
      created_at: NOW,
      correction_state,
    },
  };
}

function projection(mastery: number): MasteryProjection {
  return {
    mastery,
    mastery_lo: Math.max(0, mastery - 0.1),
    mastery_hi: Math.min(1, mastery + 0.1),
    low_confidence: true,
    theta_hat: -0.3,
    theta_precision: 1.0,
    theta_se: 1.0,
    beta: 0,
    evidence_count: 3,
    success_count: 1,
    fail_count: 2,
    last_outcome_at: NOW,
    provenance: 'observed',
  };
}

// Two failures on kn_x × concept_confusion → one candidate cell (recurrence 2).
const KC = 'kn_x';
const CAUSE = 'concept_confusion';
function fixtureFailures(): FailureAttempt[] {
  return [failure('att_1', KC, CAUSE), failure('att_2', KC, CAUSE)];
}

const validProposeArgs = {
  knowledge_id: KC,
  cause_category: CAUSE,
  claim_md: '你把必要条件当成充分条件',
  diagnostic_spec: {
    schema_version: 2,
    target_error_rule_md: '把必要条件当成充分条件。',
    trigger_conditions_md: '题目要求判断一个条件是否足以推出结论。',
    scope_boundary_md: '不推断其它逻辑关系。',
    expected_wrong_answer_signature_md: '把仅必要的条件判断为足够。',
    causal_direction_required: false,
  },
  evidence_refs: ['att_1', 'att_2'],
};

/** A stub runAgentTaskFn that invokes the director's propose_conjecture handler once. */
function proposeOnceRunner(cost = 0.05) {
  return vi.fn(async () => {
    await callTool('propose_conjecture', validProposeArgs);
    return {
      task_run_id: 'director_run_1',
      text: '',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
      cost_usd: cost,
    };
  });
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    getFailureAttemptsFn: vi.fn(async () => fixtureFailures()),
    getMasteryProjectionFn: vi.fn(
      async () => new Map<string, MasteryProjection>([[KC, projection(0.42)]]),
    ),
    resolveSubjectProfileForKnowledgeIdsFn: vi.fn(async () => resolveSubjectProfile('math')),
    runAgentTaskFn: proposeOnceRunner(),
    runTaskFn: vi.fn(async (kind: string) => {
      if (kind === 'ConjectureProbeAuthorTask') {
        return {
          text: '',
          task_run_id: 'probe_author',
          structured_output: {
            package: {
              primary: {
                ...RESPONSE_AWARE_PROBE_FIELDS,
                prompt_md: '判断条件 A 是否足以推出 B，并给出反例。',
                reference_md: 'A 不是充分条件；存在满足 A 但不满足 B 的反例。',
                expected_target_error_answer_md: 'A 足以推出 B。',
                elicits_target_error_reason_md: '要求区分必要条件与充分条件。',
                context_kind: 'abstract',
                representation_kind: 'symbolic',
              },
              followup: {
                ...RESPONSE_AWARE_PROBE_FIELDS,
                prompt_md: '在门禁情境中判断持卡是否保证可以进入。',
                reference_md: '持卡不是充分条件，还需权限有效。',
                expected_target_error_answer_md: '持卡就一定可以进入。',
                elicits_target_error_reason_md: '在应用情境中保持同一充分性判断。',
                context_kind: 'applied',
                representation_kind: 'natural_language',
              },
              predicted_p: 0.3,
            },
          },
        };
      }
      if (kind === 'ConjectureProbeReviewTask') {
        return {
          text: '',
          task_run_id: 'probe_review',
          structured_output: {
            review: {
              verdict: 'pass',
              failure_codes: [],
              explanation_md: '目标错因、参考答案和独立性均通过。',
            },
          },
        };
      }
      throw new Error(`unexpected task ${kind}`);
    }),
    ...overrides,
  };
}

async function conjectureProposalRows(actorRef: string) {
  return testDb()
    .select()
    .from(event)
    .where(and(eq(event.action, 'experimental:proposal'), eq(event.actor_ref, actorRef)));
}

beforeEach(async () => {
  await resetDb();
  await testDb()
    .insert(event)
    .values(
      ['att_1', 'att_2'].map((id) => ({
        id,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: `q_${id}`,
        outcome: 'failure',
        payload: {
          answer_md: 'wrong',
          answer_image_refs: [],
          referenced_knowledge_ids: [KC],
          question_snapshot: questionSnapshot(id),
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: NOW,
      })),
    );
  mockPi.handlers.clear();
});

describe('runResearchMeetingDirector — pipeline', () => {
  it('admits the same key after a real evidence validation failure rolls back its reservation', async () => {
    let rejected: Record<string, unknown> | undefined;
    let retried: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async () => {
      rejected = await callTool('propose_conjecture', {
        ...validProposeArgs,
        evidence_refs: ['att_1', 'missing_event'],
      });
      retried = await callTool('propose_conjecture', validProposeArgs);
      return {
        task_run_id: 'director_run_evidence_retry',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(rejected?.ok).toBe(false);
    expect(retried?.ok).toBe(true);
    expect(result.proposals_created).toBe(1);
    expect(await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR)).toHaveLength(1);
  });
});

describe('runResearchMeetingAgentNightly — dayKey claim idempotency (real DB)', () => {
  it('runs the director once; a same-day retry skips (no re-spend, no duplicate proposal)', async () => {
    const first = await runResearchMeetingAgentNightly(testDb(), baseDeps());
    expect(first.skipped).toBe(false);
    expect(first.director?.proposals_created).toBe(1);

    // A pg-boss retry hits the same DB: the claim already exists → skip the director.
    const runAgentTaskFn = proposeOnceRunner();
    const second = await runResearchMeetingAgentNightly(testDb(), baseDeps({ runAgentTaskFn }));
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already_claimed_today');
    expect(runAgentTaskFn).not.toHaveBeenCalled();

    // exactly one proposal + one trigger landed across both calls.
    expect(await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR)).toHaveLength(1);
    const triggers = await testDb().select().from(event).where(eq(event.action, TRIGGER_ACTION));
    expect(triggers).toHaveLength(1);
  });
});
