// YUK-572 PR-2 — director pipeline db test. Real Postgres (testcontainer); the SDK is
// mocked so the in-process tool handlers are captured, and an injected stub runAgentTaskFn
// DRIVES those handlers (fake LLM tool-call flow) instead of spawning a `claude`
// subprocess. Everything below the SDK runs for real: writeAiProposal → the proposal row,
// listProposalInboxRows → the cross-actor dedup base, the trigger/scan events, and the
// dayKey claim gate. Asserts: proposal landing + actor + baseline snapshot + cost-bearing
// scan, cross-actor dedup, degrade, shadow isolation, and claim idempotency.

import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { WriteEventInput } from '@/kernel/events';
import type { FailureAttempt } from '@/server/events/queries';
import type { MasteryProjection } from '@/server/mastery/state';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { runResearchMeetingAgentNightly } from '../../jobs/research_meeting_agent_nightly';
import {
  EVIDENCE_SCOUT_CHARTER,
  RESEARCH_MEETING_AGENT_ACTOR,
  SCAN_ACTION,
  SCOUT_SPAWNED_ACTION,
  TRIGGER_ACTION,
  runResearchMeetingDirector,
} from './director';

const NOW = new Date('2026-07-06T21:00:00.000Z'); // 05:00 BJT 2026-07-07

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
  probe_md: '给出一道只有该误解才会答错的判别题',
  probe_reference_md: '参考答案：一个必要不充分的反例',
  predicted_p: 0.3,
  discriminating: true,
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
    runAgentTaskFn: proposeOnceRunner(),
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
          answer_md: 'still wrong',
          answer_image_refs: [],
          referenced_knowledge_ids: [KC],
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

    const result = await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

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

  it('idempotent id-keyed spawn cap: BOTH layers consulted for the SAME call agree (round-3 review A1 — stronger than "hook increments, canUseTool reads-only")', async () => {
    // Round-2's design ("hook increments, canUseTool reads-only") has a real flaw if the
    // SDK consults BOTH layers for the SAME single Task call: hook grants + increments
    // 0→1 for the FIRST spawn, then canUseTool re-checks the ALREADY-incremented counter
    // for that SAME call and would incorrectly deny the very call the hook just approved
    // — under MAX_SCOUT_SPAWNS=1 the scout would never successfully spawn at all. The
    // fix keys the decision on `tool_use_id` (PreToolUseHookInput) / `toolUseID`
    // (canUseTool's options) — the SAME per-call correlation id on both SDK surfaces
    // (sdk.d.ts:2167-2172 / CanUseTool options) — so a SECOND consultation of an
    // ALREADY-granted call re-allows (idempotent), while a genuinely NEW call is capped.
    let capturedHooks:
      | { PreToolUse?: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }
      | undefined;
    let capturedCanUseTool:
      | ((toolName: string, input: unknown, options: { toolUseID: string }) => Promise<unknown>)
      | undefined;
    const runAgentTaskFn = vi.fn(async (_kind: string, _input: unknown, ctx: never) => {
      capturedHooks = (ctx as { hooks?: typeof capturedHooks }).hooks;
      capturedCanUseTool = (ctx as { canUseTool?: typeof capturedCanUseTool }).canUseTool;
      return {
        task_run_id: 'director_run_a1',
        text: '',
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost_usd: 0.01,
      };
    });

    await runResearchMeetingDirector(testDb(), baseDeps({ runAgentTaskFn }));

    const hookFn = capturedHooks?.PreToolUse?.[0]?.hooks[0];
    expect(hookFn).toBeTypeOf('function');
    expect(capturedCanUseTool).toBeTypeOf('function');
    const canUseTool = capturedCanUseTool as NonNullable<typeof capturedCanUseTool>;
    const invokeHook = hookFn as NonNullable<typeof hookFn>;

    // Call #1 ('call-1'): simulate BOTH layers consulted for the SAME call, hook first
    // (per sdk.d.ts:3446, a hook deny bypasses canUseTool — implying hook runs first).
    const hook1 = await invokeHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: 'call-1',
    });
    expect(hook1).toMatchObject({ continue: true });
    const cut1 = await canUseTool('Task', {}, { toolUseID: 'call-1' });
    // MUST allow — canUseTool is re-asked about the SAME already-granted call, not a new one.
    expect(cut1).toMatchObject({ behavior: 'allow' });

    // Call #2 ('call-2'): a genuinely NEW call — both layers must deny it.
    const hook2 = await invokeHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: 'call-2',
    });
    expect(hook2).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    const cut2 = await canUseTool('Task', {}, { toolUseID: 'call-2' });
    expect(cut2).toMatchObject({ behavior: 'deny' });

    // A non-spawn tool is never denied by either layer.
    const nonSpawnHook = await invokeHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__research_evidence__get_question',
      tool_use_id: 'call-3',
    });
    expect(nonSpawnHook).toMatchObject({ continue: true });
    const nonSpawnCanUseTool = await canUseTool(
      'mcp__research_evidence__get_question',
      {},
      { toolUseID: 'call-3' },
    );
    expect(nonSpawnCanUseTool).toMatchObject({ behavior: 'allow' });
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
