// YUK-572 PR-2 — director pipeline db test. Real Postgres (testcontainer); the SDK is
// mocked so the in-process tool handlers are captured, and an injected stub runAgentTaskFn
// DRIVES those handlers (fake LLM tool-call flow) instead of spawning a `claude`
// subprocess. Everything below the SDK runs for real: writeAiProposal → the proposal row,
// listProposalInboxRows → the cross-actor dedup base, the trigger/scan events, and the
// dayKey claim gate. Asserts: proposal landing + actor + baseline snapshot + cost-bearing
// scan, cross-actor dedup, degrade, shadow isolation, and claim idempotency.

import { conjectureKey } from '@/capabilities/agency/server/conjecture/evidence';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { WriteEventInput } from '@/kernel/events';
import { SPAWN_BUDGET_MODE, SPAWN_TOOL_NAME } from '@/server/ai/spawn-contract';
import type { FailureAttempt } from '@/server/events/queries';
import type { MasteryProjection } from '@/server/mastery/state';
import { writeAiProposal } from '@/server/proposals/writer';
import { resolveSubjectProfile } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESPONSE_AWARE_PROBE_FIELDS } from '../../../../../tests/helpers/conjecture-probe-fixtures';
import { resetDb, testDb } from '../../../../../tests/helpers/db';

// Capture the registered tool handlers via a mocked SDK (same shape as evidence-mcp.db.test).
const mockSdk = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (args: unknown) => Promise<{ content: { type: string; text: string }[] }>
  >(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({
    type: 'sdk',
    name: opts.name,
    instance: {},
  })),
  tool: vi.fn(
    (
      name: string,
      _desc: string,
      _schema: unknown,
      handler: (args: unknown) => Promise<{ content: { type: string; text: string }[] }>,
    ) => {
      mockSdk.handlers.set(name, handler);
      return { name };
    },
  ),
  query: vi.fn(),
}));

import {
  RECOVERY_CLAIM_ACTION,
  RETRYABLE_FAILURE_ACTION,
  runResearchMeetingAgentNightly,
} from '../../jobs/research_meeting_agent_nightly';
import {
  type DirectorDeps,
  EVIDENCE_SCOUT_CHARTER,
  RESEARCH_MEETING_AGENT_ACTOR,
  SCAN_ACTION,
  SCOUT_SPAWNED_ACTION,
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
  const handler = mockSdk.handlers.get(name);
  if (!handler) throw new Error(`no registered handler for ${name}`);
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
  mockSdk.handlers.clear();
});

describe('evidence scout charter', () => {
  it('advertises review ids on the detail reader', () => {
    expect(EVIDENCE_SCOUT_CHARTER).toContain('get_attempt_details（按 attempt/review 事件 id');
  });

  it('permits review events as primary evidence', () => {
    expect(EVIDENCE_SCOUT_CHARTER).toContain('attempt/review/probe/prediction_score');
    expect(EVIDENCE_SCOUT_CHARTER).not.toContain(
      'evidence_refs 只能是 attempt/probe/prediction_score',
    );
  });
});

describe('runResearchMeetingDirector — pipeline', () => {
  it('owns one outer lifecycle controller and propagates only its signal to nested probes', async () => {
    type OuterRunner = NonNullable<DirectorDeps['runAgentTaskFn']>;
    type NestedRunner = NonNullable<DirectorDeps['runTaskFn']>;
    type OuterContext = Parameters<OuterRunner>[2];
    type NestedContext = Parameters<NestedRunner>[2];

    let outerContext: OuterContext | undefined;
    const nestedContexts: NestedContext[] = [];
    const defaultProbeRunner = baseDeps().runTaskFn as NestedRunner;
    const runTaskFn: NestedRunner = async (kind, input, ctx) => {
      nestedContexts.push(ctx);
      return defaultProbeRunner(kind, input, ctx);
    };
    const runAgentTaskFn: OuterRunner = async (_kind, _input, ctx) => {
      outerContext = ctx;
      await callTool('propose_conjecture', validProposeArgs);
      return {
        task_run_id: 'director_lifecycle_wiring',
        cost_usd: 0.01,
      };
    };

    const result = await runResearchMeetingDirector(
      testDb(),
      baseDeps({ runAgentTaskFn, runTaskFn }),
    );

    expect(result.proposals_created).toBe(1);
    const controller = outerContext?.lifecycleAbortController;
    expect(controller).toBeInstanceOf(AbortController);
    expect(outerContext?.taskRunId).toBeTruthy();
    expect(nestedContexts).toHaveLength(2);
    for (const ctx of nestedContexts) {
      expect(ctx?.parentTaskRunId).toBe(outerContext?.taskRunId);
      expect(ctx?.signal).toBe(controller?.signal);
      expect(ctx?.lifecycleAbortController).toBeUndefined();
    }
  });

  it('seeds write caps from durable outputs of earlier same-day director triggers', async () => {
    const priorTriggerId = 'research_meeting_agent_prior_trigger';
    await testDb()
      .insert(event)
      .values([
        {
          id: priorTriggerId,
          session_id: null,
          actor_kind: 'agent',
          actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
          action: TRIGGER_ACTION,
          subject_kind: 'query',
          subject_id: priorTriggerId,
          outcome: 'success',
          payload: { day_key: '2026-07-07' },
          caused_by_event_id: null,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: NOW,
        },
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `prior_proposal_${index}`,
          session_id: null,
          actor_kind: 'agent' as const,
          actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
          action: 'experimental:proposal',
          subject_kind: 'mind_model' as const,
          subject_id: KC,
          outcome: null,
          payload: {},
          caused_by_event_id: priorTriggerId,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: NOW,
        })),
        ...Array.from({ length: 2 }, (_, index) => ({
          id: `prior_note_${index}`,
          session_id: null,
          actor_kind: 'agent' as const,
          actor_ref: RESEARCH_MEETING_AGENT_ACTOR,
          action: 'experimental:agent_note',
          subject_kind: 'query' as const,
          subject_id: `prior_note_${index}`,
          outcome: null,
          payload: {},
          caused_by_event_id: priorTriggerId,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: NOW,
        })),
      ]);

    let proposalResult: Record<string, unknown> | undefined;
    let noteResult: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async () => {
      proposalResult = await callTool('propose_conjecture', validProposeArgs);
      noteResult = await callTool('leave_agent_note', {
        target_agents: ['dreaming'],
        refs: [],
        summary_md: 'recovery should not exceed the nightly note cap',
        signal_kind: 'evidence_gap',
      });
      return {
        task_run_id: 'director_recovery_caps',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(proposalResult).toMatchObject({ ok: false, reason: expect.stringContaining('上限') });
    expect(noteResult).toMatchObject({ ok: false, reason: expect.stringContaining('上限') });
    expect(result.proposals_created).toBe(0);
    expect(result.notes_created).toBe(0);
  });

  it('applies conjecture lifecycle history to both the agenda and write guard', async () => {
    let context: Record<string, unknown> | undefined;
    let proposeResult: Record<string, unknown> | undefined;
    const acceptedAt = new Date(NOW.getTime() - 1_000);
    const loadConjectureHistoryFn = vi.fn(async () => {
      return new Map([
        [
          conjectureKey(CAUSE, KC),
          {
            latest_decision: 'accept' as const,
            latest_decision_at: acceptedAt,
            latest_accept_at: acceptedAt,
            latest_terminal_at: null,
            prior_claim_md: 'owner prior',
          },
        ],
      ]);
    });
    const runAgentTaskFn = vi.fn(async () => {
      context = await callTool('get_meeting_context', {});
      proposeResult = await callTool('propose_conjecture', validProposeArgs);
      return {
        task_run_id: 'director_history_gate',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(
      testDb(),
      baseDeps({ loadConjectureHistoryFn, runAgentTaskFn }),
    );

    expect(context?.candidate_cells).toEqual([]);
    expect(proposeResult?.ok).toBe(false);
    expect(String(proposeResult?.reason)).toMatch(/lifecycle|owner decision/);
    expect(result.proposals_created).toBe(0);
  });

  it('rejects a proposal when an evidence_ref does not resolve to a real event', async () => {
    let proposeResult: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async () => {
      proposeResult = await callTool('propose_conjecture', {
        ...validProposeArgs,
        evidence_refs: ['att_1', 'missing_event'],
      });
      return {
        task_run_id: 'director_run_missing_evidence',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(proposeResult?.ok).toBe(false);
    expect(String(proposeResult?.reason)).toMatch(/不存在|事件/);
    expect(result.proposals_created).toBe(0);
    expect(await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR)).toHaveLength(0);
  });

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

  it('accepts a review event as primary evidence', async () => {
    await testDb()
      .insert(event)
      .values({
        id: 'review_1',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q_review_1',
        outcome: 'failure',
        payload: {
          user_response_md: 'still wrong',
          answer_image_refs: [],
          referenced_knowledge_ids: [KC],
          question_snapshot: questionSnapshot('review_1'),
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: NOW,
      });
    let proposeResult: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async () => {
      proposeResult = await callTool('propose_conjecture', {
        ...validProposeArgs,
        evidence_refs: ['review_1'],
      });
      return {
        task_run_id: 'director_run_review_evidence',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(
      testDb(),
      baseDeps({
        runAgentTaskFn,
        getFailureAttemptsFn: vi.fn(async () => [
          ...fixtureFailures(),
          failure('review_1', KC, CAUSE),
        ]),
      }),
    );

    expect(proposeResult?.ok).toBe(true);
    expect(result.proposals_created).toBe(1);
    const proposals = await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload).toMatchObject({
      ai_proposal: { evidence_refs: [{ kind: 'event', id: 'review_1' }] },
    });
  });

  it('rejects a corrected failed review event as primary evidence', async () => {
    await testDb()
      .insert(event)
      .values([
        {
          id: 'review_corrected',
          session_id: null,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'review',
          subject_kind: 'question',
          subject_id: 'q_review_corrected',
          outcome: 'failure',
          payload: {},
          caused_by_event_id: null,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: NOW,
        },
        {
          id: 'correct_review_corrected',
          session_id: null,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: 'review_corrected',
          outcome: 'success',
          payload: {
            correction_kind: 'retract',
            reason_md: 'review was recorded incorrectly',
            affected_refs: [{ kind: 'question', id: 'q_review_corrected' }],
          },
          caused_by_event_id: null,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: new Date(NOW.getTime() + 1_000),
        },
      ]);
    let proposeResult: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async () => {
      proposeResult = await callTool('propose_conjecture', {
        ...validProposeArgs,
        evidence_refs: ['review_corrected'],
      });
      return {
        task_run_id: 'director_run_corrected_review_evidence',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(proposeResult?.ok).toBe(false);
    expect(result.proposals_created).toBe(0);
    expect(await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR)).toHaveLength(0);
  });

  it('rejects a successful review event as primary evidence', async () => {
    await testDb().insert(event).values({
      id: 'review_success',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_review_success',
      outcome: 'success',
      payload: {},
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: NOW,
    });
    let proposeResult: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async () => {
      proposeResult = await callTool('propose_conjecture', {
        ...validProposeArgs,
        evidence_refs: ['review_success'],
      });
      return {
        task_run_id: 'director_run_successful_review_evidence',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(proposeResult?.ok).toBe(false);
    expect(result.proposals_created).toBe(0);
    expect(await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR)).toHaveLength(0);
  });

  it('rejects an existing event whose action is not primary evidence', async () => {
    await writeEvent(testDb(), {
      id: 'existing_non_primary_event',
      actor_kind: 'system',
      actor_ref: 'test',
      action: 'experimental:research_meeting_agent_trigger',
      subject_kind: 'query',
      subject_id: 'existing_non_primary_event',
      outcome: 'success',
      payload: {},
      created_at: NOW,
    });
    let proposeResult: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async () => {
      proposeResult = await callTool('propose_conjecture', {
        ...validProposeArgs,
        evidence_refs: ['att_1', 'existing_non_primary_event'],
      });
      return {
        task_run_id: 'director_run_non_primary_evidence',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(proposeResult?.ok).toBe(false);
    expect(String(proposeResult?.reason)).toMatch(/一手|事件/);
    expect(result.proposals_created).toBe(0);
  });

  it('lands a mind_model conjecture with the agent actor + server baseline snapshot + cost-bearing scan', async () => {
    const result = await runResearchMeetingDirector(testDb(), baseDeps());

    expect(result.proposals_created).toBe(1);
    expect(result.outcome).toBe('success');
    expect(result.cost_usd).toBeCloseTo(0.05, 6);

    const proposals = await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR);
    expect(proposals).toHaveLength(1);
    // A conjecture remains memory-eligible: it is an evidence-backed learner belief,
    // unlike the surrounding execution bookkeeping.
    expect(proposals[0].ingest_at).toBeNull();
    const payload = proposals[0].payload as { ai_proposal: Record<string, unknown> };
    const ai = payload.ai_proposal as {
      kind: string;
      target: { subject_kind: string; subject_id: string };
      proposed_change: Record<string, unknown>;
    };
    expect(ai.kind).toBe('conjecture');
    expect(ai.target).toMatchObject({ subject_kind: 'mind_model', subject_id: KC });
    expect(ai.proposed_change).toMatchObject({
      knowledge_id: KC,
      cause_category: CAUSE,
      baseline_p_at_induction: 0.42, // server-snapshotted from the cell's mastery
      confidence: 0.4, // fixed conservative — never LLM-reported
      recurrence_count: 2,
      corrected_by_owner: false,
    });

    // scan event carries the run cost ONCE (proposals are 0-cost → no double-count).
    const scans = await testDb().select().from(event).where(eq(event.action, SCAN_ACTION));
    expect(scans).toHaveLength(1);
    expect(scans[0].cost_micro_usd).toBe(50_000);
    expect(scans[0].payload).toMatchObject({ proposals_created: 1, outcome: 'success' });
    expect(scans[0].ingest_at).not.toBeNull();
    expect(scans[0].affected_scopes).toEqual([]);

    const triggers = await testDb().select().from(event).where(eq(event.action, TRIGGER_ACTION));
    expect(triggers).toHaveLength(1);
    expect(triggers[0].ingest_at).not.toBeNull();
    expect(triggers[0].affected_scopes).toEqual([]);
  });

  it('records a genuine zero cost as 0 (not null) — round-3 review OCR #7, dreaming_nightly:388 precedent (null means UNKNOWN/degraded, not "no spend")', async () => {
    const runAgentTaskFn = vi.fn(async () => {
      await callTool('propose_conjecture', validProposeArgs);
      return {
        task_run_id: 'director_run_zero_cost',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0, // flat OAuth lane genuinely reporting no per-call cost — NOT degraded
      };
    });
    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));
    expect(result.outcome).toBe('success');
    expect(result.cost_usd).toBe(0); // round-5 review minor 0.80 — genuinely $0, NOT null
    const scans = await testDb().select().from(event).where(eq(event.action, SCAN_ACTION));
    expect(scans).toHaveLength(1);
    expect(scans[0].cost_micro_usd).toBe(0); // NOT null — a successful run's real 0 is a fact
  });

  it('dedups against a pending conjecture the deterministic lane already raised (cross-actor)', async () => {
    // Seed a PENDING conjecture from the deterministic lane (actor research_meeting).
    await writeAiProposal(testDb(), {
      actor_ref: 'research_meeting',
      payload: {
        kind: 'conjecture',
        target: { subject_kind: 'mind_model', subject_id: KC },
        reason_md: 'deterministic lane already raised this belief',
        evidence_refs: [{ kind: 'event', id: 'att_1' }],
        cooldown_key: `conjecture:${CAUSE}::${KC}`,
        proposed_change: {
          claim_md: '确定性 lane 的猜想',
          knowledge_id: KC,
          cause_category: CAUSE,
          confidence: 0.7,
          recurrence_count: 2,
          probe_md: 'probe',
          probe_reference_md: 'reference',
          discriminating: true,
          predicted_p: 0.3,
          baseline_p_at_induction: 0.5,
        },
      },
    });

    let proposeResult: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async () => {
      proposeResult = await callTool('propose_conjecture', validProposeArgs);
      return {
        task_run_id: 'director_run_2',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(proposeResult?.ok).toBe(false); // dedup base is ALL pending, cross-actor
    expect(result.proposals_created).toBe(0);
    // the agent lane wrote NO new conjecture proposal for this cell.
    expect(await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR)).toHaveLength(0);
  });

  it('degrades on a director run throw: partial scan event, no rethrow', async () => {
    const runAgentTaskFn = vi.fn(async () => {
      throw new Error('error_max_turns');
    });
    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(result.outcome).toBe('failure'); // nothing landed before the throw
    expect(result.proposals_created).toBe(0);
    // round-5 review minor 0.80 — degraded result.cost_usd is null (unknown), matching
    // the scan event's cost_micro_usd:null semantics for the SAME degrade — a bare 0
    // here would be indistinguishable from a genuine free successful run.
    expect(result.cost_usd).toBeNull();

    const scans = await testDb().select().from(event).where(eq(event.action, SCAN_ACTION));
    expect(scans).toHaveLength(1);
    expect(scans[0].outcome).toBe('failure');
    expect(scans[0].cost_micro_usd).toBeNull(); // degrade spend is not accounted (§7)
    expect(scans[0].payload).toMatchObject({ error: 'error_max_turns' });
  });

  it('does not throw when persistToolTraceFn fails post-run — returns a degraded/partial result (§3 review fix MAJOR)', async () => {
    const runAgentTaskFn = vi.fn(async () => {
      // Exercise an evidence read tool so the toolTrace is non-empty — persistToolTraceFn
      // is only invoked at all when trace.length > 0. A nonexistent attempt_event_id
      // still pushes a toolTrace entry (evidence-mcp.ts traces found:false calls too).
      await callTool('get_attempt_details', { attempt_event_id: 'nonexistent_att' });
      await callTool('propose_conjecture', validProposeArgs);
      return {
        task_run_id: 'director_run_persist_fail',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.03,
      };
    });
    const persistToolTraceFn = vi.fn(async () => {
      throw new Error('tool_call_log write blew up');
    });

    const result = await runResearchMeetingDirector(
      testDb(),
      baseDeps({ runAgentTaskFn, persistToolTraceFn }),
    );

    // The persistence failure must NOT propagate — proposals still landed, so this is
    // 'partial' (some progress + a post-run write hiccup), not 'failure'.
    expect(result.outcome).toBe('partial');
    expect(result.proposals_created).toBe(1);
    expect(persistToolTraceFn).toHaveBeenCalledTimes(1);

    // The scan event STILL gets written (its own independent try/catch) and records the
    // 'partial' outcome so the failure is observable, not silently swallowed.
    const scans = await testDb().select().from(event).where(eq(event.action, SCAN_ACTION));
    expect(scans).toHaveLength(1);
    expect(scans[0].payload).toMatchObject({ outcome: 'partial' });
  });

  it('accumulates postRunError across MULTIPLE post-run write failures (round-2 review MINOR #7 — was "keep first only")', async () => {
    const runAgentTaskFn = vi.fn(async (_kind: string, _input: unknown, ctx: never) => {
      // Exercise an evidence read tool (non-empty toolTrace → persistToolTraceFn invoked).
      await callTool('get_attempt_details', { attempt_event_id: 'nonexistent_att' });
      // Manually drive the PreToolUse hook for a Task call (the stub never spawns a real
      // subagent) to bump scoutSpawns → the scout_spawned event write is attempted.
      const hooks = (ctx as { hooks?: { PreToolUse?: Array<{ hooks: unknown[] }> } }).hooks;
      const hookFn = hooks?.PreToolUse?.[0]?.hooks[0] as (input: unknown) => Promise<unknown>;
      await hookFn({
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: { subagent_type: 'evidence-scout' },
        tool_use_id: 'test-spawn-1',
      });
      await callTool('propose_conjecture', validProposeArgs);
      return {
        task_run_id: 'director_run_multi_fail',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.02,
      };
    });
    const persistToolTraceFn = vi.fn(async () => {
      throw new Error('tool_call_log write blew up');
    });
    const writeEventFn = vi.fn(async (db: unknown, input: WriteEventInput) => {
      if (input.action === SCOUT_SPAWNED_ACTION) {
        expect(input.ingest_at).toEqual(NOW);
        throw new Error('scout_spawned write blew up');
      }
      return writeEvent(db as never, input);
    });

    const result = await runResearchMeetingDirector(
      testDb(),
      baseDeps({ runAgentTaskFn, persistToolTraceFn, writeEventFn }),
    );

    expect(result.outcome).toBe('partial');
    const scans = await testDb().select().from(event).where(eq(event.action, SCAN_ACTION));
    expect(scans).toHaveLength(1);
    const postRunError = (scans[0].payload as { post_run_error?: string }).post_run_error;
    expect(postRunError).toContain('tool_call_log write blew up');
    expect(postRunError).toContain('scout_spawned write blew up');
  });

  it('uses the shared v2 depth-one/report-only contract across interleaved hook + permission calls', async () => {
    const decisions: unknown[] = [];
    let capturedInput: Record<string, unknown> | undefined;
    let capturedAgent:
      | { tools?: string[]; disallowedTools?: string[]; prompt?: string }
      | undefined;
    const runAgentTaskFn = vi.fn(async (_kind: string, input: unknown, ctx: never) => {
      capturedInput = input as Record<string, unknown>;
      const spawnCtx = ctx as {
        hooks?: { PreToolUse?: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
        canUseTool?: (
          toolName: string,
          input: unknown,
          options: { toolUseID: string },
        ) => Promise<unknown>;
        agents?: Record<string, { tools?: string[]; disallowedTools?: string[]; prompt?: string }>;
      };
      const hook = spawnCtx.hooks?.PreToolUse?.[0]?.hooks[0];
      const canUseTool = spawnCtx.canUseTool;
      capturedAgent = spawnCtx.agents?.['evidence-scout'];
      if (!hook || !canUseTool) throw new Error('missing shared spawn contract');

      // Realistic consultation order: the permission callback sees one Task first,
      // the hook sees another first, then both surfaces re-check the same ids while
      // evidence reads interleave. Three unique spawns remain allowed: v1's count=1
      // cap is retired and the budget is observation-only.
      decisions.push(
        await canUseTool(
          SPAWN_TOOL_NAME,
          { subagent_type: 'evidence-scout' },
          { toolUseID: 'spawn-logic-a' },
        ),
        await hook({
          hook_event_name: 'PreToolUse',
          tool_name: 'mcp__research_evidence__get_attempt_details',
          tool_use_id: 'read-att-17',
        }),
        await hook({
          hook_event_name: 'PreToolUse',
          tool_name: SPAWN_TOOL_NAME,
          tool_input: { subagent_type: 'evidence-scout' },
          tool_use_id: 'spawn-applied-b',
        }),
        await canUseTool(
          SPAWN_TOOL_NAME,
          { subagent_type: 'evidence-scout' },
          { toolUseID: 'spawn-applied-b' },
        ),
        await hook({
          hook_event_name: 'PreToolUse',
          tool_name: SPAWN_TOOL_NAME,
          tool_input: { subagent_type: 'evidence-scout' },
          tool_use_id: 'spawn-logic-a',
        }),
        await canUseTool(
          SPAWN_TOOL_NAME,
          { subagent_type: 'evidence-scout' },
          { toolUseID: 'spawn-review-c' },
        ),
      );
      return {
        task_run_id: 'director_run_a1',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    expect(decisions).toEqual([
      expect.objectContaining({ behavior: 'allow' }),
      expect.objectContaining({ continue: true }),
      expect.objectContaining({ continue: true }),
      expect.objectContaining({ behavior: 'allow' }),
      expect.objectContaining({ continue: true }),
      expect.objectContaining({ behavior: 'allow' }),
    ]);
    expect(result.scout_spawned).toBe(3);
    expect(capturedInput?.budget).toEqual({
      max_turns: 24,
      max_wall_clock_s: 300,
      spawn_budget_mode: SPAWN_BUDGET_MODE,
      max_proposals: 3,
    });
    expect(capturedAgent?.tools).not.toContain(SPAWN_TOOL_NAME);
    expect(capturedAgent?.disallowedTools).toContain(SPAWN_TOOL_NAME);

    const scoutEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, SCOUT_SPAWNED_ACTION));
    expect(scoutEvents).toHaveLength(1);
    expect(scoutEvents[0]?.payload).toMatchObject({
      spawns: 3,
      spawn_budget_mode: SPAWN_BUDGET_MODE,
    });
    const scans = await testDb().select().from(event).where(eq(event.action, SCAN_ACTION));
    expect(scans[0]?.payload).toMatchObject({
      scout_spawned: 3,
      spawn_budget_mode: SPAWN_BUDGET_MODE,
    });
  });

  it('shadow isolation: the agent run writes only research_meeting_agent-actor rows', async () => {
    await runResearchMeetingDirector(testDb(), baseDeps());
    // The deterministic control actor is never written by the agent lane.
    const controlRows = await testDb()
      .select()
      .from(event)
      .where(eq(event.actor_ref, 'research_meeting'));
    expect(controlRows).toHaveLength(0);
  });
});

describe('runResearchMeetingAgentNightly — dayKey claim idempotency (real DB)', () => {
  it('retries the same-day claim after a probe quality operational outage', async () => {
    const outageRunner = vi.fn(async () => {
      await callTool('propose_conjecture', validProposeArgs);
      return {
        task_run_id: 'director_probe_outage',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });
    const outageProbe = vi.fn(async () => {
      throw new Error('provider unavailable');
    });

    await expect(
      runResearchMeetingAgentNightly(
        testDb(),
        baseDeps({ runAgentTaskFn: outageRunner, runTaskFn: outageProbe }),
      ),
    ).rejects.toThrow('probe author failed twice');

    const scansAfterOutage = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, SCAN_ACTION));
    expect(scansAfterOutage).toHaveLength(0);
    expect(await conjectureProposalRows(RESEARCH_MEETING_AGENT_ACTOR)).toHaveLength(0);
    expect(
      await testDb().select().from(event).where(eq(event.action, RETRYABLE_FAILURE_ACTION)),
    ).toHaveLength(1);

    const retried = await runResearchMeetingAgentNightly(testDb(), baseDeps());
    expect(retried.skipped).toBe(false);
    expect(retried.director?.proposals_created).toBe(1);

    const scansAfterRetry = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, SCAN_ACTION));
    expect(scansAfterRetry).toHaveLength(1);
    const recoveries = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, RECOVERY_CLAIM_ACTION));
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].payload).toMatchObject({
      attempt_kind: 'recovery',
      recovery_attempt: 1,
    });
  });

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
