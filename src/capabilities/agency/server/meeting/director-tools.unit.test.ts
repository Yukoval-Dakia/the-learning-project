// YUK-572 PR-2 — director write-face tool server unit tests. Pure, no DB:
// `buildDirectorServer` returns pi `AgentTool`s directly (post-P4 `custom`
// mount surface), so the harness invokes `tool.execute` with injected fake
// writers. Asserts the server-side single-writer discipline:
// propose_conjecture cap / pending-dedup / Zod / baseline_p auto-snapshot, and
// leave_agent_note cap / target whitelist / summary truncation / primary-ref filter.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WriteAgentNoteInput } from '@/capabilities/agency/server/notes';
import type { FailureAttempt } from '@/capabilities/knowledge/public';
import { activeEffectiveTruth } from '@/kernel/events';
import type { WriteAiProposalInput } from '@/kernel/proposals/writer';
import type { MasteryProjection } from '@/server/mastery/state';
import { resolveSubjectProfile } from '@/subjects/profile';
import { RESPONSE_AWARE_PROBE_FIELDS } from '../../../../../tests/helpers/conjecture-probe-fixtures';

// The built DirectorServer's tools list is captured per build() for direct
// `execute` invocation (pi AgentTool: `name` is the wire name, `label` the
// bare tool name).
const captured = vi.hoisted(() => ({
  tools: [] as { name: string; label: string }[],
}));

import {
  type BuildDirectorServerOpts,
  type MeetingContext,
  buildDirectorServer,
  createDirectorCaps,
} from './director-tools';

const NOW = new Date('2026-07-06T00:00:00.000Z');

async function callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
  const tool = captured.tools.find((t) => t.label === name);
  if (!tool) throw new Error(`no registered tool for ${name}`);
  const res = await (
    tool as unknown as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ content: { type: string; text: string }[] }>;
    }
  ).execute(`call_${name}`, args);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

function cell(overrides: Partial<MeetingContext['candidate_cells'][number]> = {}) {
  return {
    knowledge_id: 'k_a',
    cause_category: 'concept_confusion',
    recurrence_count: 3,
    baseline_p: 0.42,
    theta_precision: 1.0,
    probe_here: true,
    evidence_event_ids: ['att_1', 'att_2', 'att_3'],
    ...overrides,
  };
}

function meetingContext(overrides: Partial<MeetingContext> = {}): MeetingContext {
  return {
    pending_conjectures: [],
    candidate_cells: [cell()],
    recent_failure_summary: { window_days: 14, total_failures: 5, distinct_kcs: 2 },
    ...overrides,
  };
}

function validProposeArgs(overrides: Record<string, unknown> = {}) {
  return {
    knowledge_id: 'k_a',
    cause_category: 'concept_confusion',
    claim_md: '你把必要条件当成充分条件',
    diagnostic_spec: {
      schema_version: 2,
      target_error_rule_md: '把必要条件当成充分条件。',
      trigger_conditions_md: '题目要求判断条件是否足以推出结论。',
      scope_boundary_md: '不推断其它逻辑关系。',
      expected_wrong_answer_signature_md: '把仅必要的条件判断为足够。',
      causal_direction_required: false,
    },
    evidence_refs: ['att_1', 'att_2'],
    ...overrides,
  };
}

function failureAttempt(
  attemptEventId: string,
  overrides: Partial<FailureAttempt> = {},
): FailureAttempt {
  const questionId = `q_${attemptEventId}`;
  return {
    attempt_event_id: attemptEventId,
    question_id: questionId,
    answer_md: 'A 足以推出 B。',
    answer_image_refs: [],
    referenced_knowledge_ids: ['k_a'],
    question_snapshot: {
      schema_version: 1,
      question: {
        question_id: questionId,
        question_version: 1,
        parent_question_id: null,
        prompt_md: `判断 ${attemptEventId} 中的条件 A 是否足以推出结论 B。`,
        reference_md: 'A 不是充分条件。',
        choices_md: null,
        image_refs: [],
        figures: [],
        updated_at: NOW.toISOString(),
      },
      parent_question: null,
    },
    created_at: NOW,
    correction_state: activeEffectiveTruth(attemptEventId),
    ...overrides,
  };
}

interface Harness {
  proposals: WriteAiProposalInput[];
  notes: WriteAgentNoteInput[];
  caps: ReturnType<typeof createDirectorCaps>;
  director: ReturnType<typeof buildDirectorServer>;
  nestedTaskContexts: unknown[];
}

function build(opts: Partial<BuildDirectorServerOpts> = {}): Harness {
  captured.tools = [];
  const proposals: WriteAiProposalInput[] = [];
  const notes: WriteAgentNoteInput[] = [];
  const nestedTaskContexts: unknown[] = [];
  const caps = createDirectorCaps();
  const director = buildDirectorServer({
    db: {} as never,
    now: NOW,
    meetingContext: meetingContext(),
    knownConjectureKeys: new Set<string>(),
    caps,
    triggerEventId: 'trigger_1',
    toolContextTaskRunId: 'toolrun_1',
    failureAttempts: [
      ...Array.from({ length: 13 }, (_, index) => failureAttempt(`att_${index}`)),
      failureAttempt('att_only_one'),
    ],
    loadConjectureHistoryFn: async () => new Map(),
    writeAiProposalFn: async (_db, input) => {
      proposals.push(input);
      return `prop_${proposals.length}`;
    },
    writeAgentNoteFn: async (_db, input) => {
      notes.push(input);
      return `agent_note_${notes.length}`;
    },
    getMasteryProjectionFn: async () => new Map<string, MasteryProjection>(),
    evidenceRefsExistFn: async () => true,
    resolveSubjectProfileForKnowledgeIdsFn: async () => resolveSubjectProfile('general'),
    parentLifecycleSignal: new AbortController().signal,
    runTaskFn: async (kind, _input, ctx) => {
      nestedTaskContexts.push(ctx);
      if (kind === 'ConjectureProbeAuthorTask') {
        return {
          text: '',
          task_run_id: 'probe_author',
          structured_output: {
            package: {
              primary: {
                ...RESPONSE_AWARE_PROBE_FIELDS,
                prompt_md: '判断条件 A 是否足以推出结论 B，并给出反例。',
                reference_md: 'A 不是充分条件；反例满足 A 但不满足 B。',
                expected_target_error_answer_md: 'A 足以推出 B。',
                elicits_target_error_reason_md: '要求区分必要与充分。',
                context_kind: 'abstract',
                representation_kind: 'symbolic',
              },
              followup: {
                ...RESPONSE_AWARE_PROBE_FIELDS,
                prompt_md: '在门禁规则情境中判断持卡是否保证可以进入。',
                reference_md: '持卡只是必要条件，还需权限有效，因此不能保证进入。',
                expected_target_error_answer_md: '持卡就一定可以进入。',
                elicits_target_error_reason_md: '在应用语境中保持同一充分性判断。',
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
              explanation_md: '两题保持目标错因并改变情境与表征。',
            },
          },
        };
      }
      throw new Error(`unexpected task ${kind}`);
    },
    ...opts,
  });
  captured.tools = director.tools;
  return { proposals, notes, caps, director, nestedTaskContexts };
}

beforeEach(() => {
  captured.tools = [];
});

describe('propose_conjecture — server-enforced single writer', () => {
  it('rolls back a thrown evidence validator reservation so the same key can retry', async () => {
    const evidenceRefsExistFn = vi
      .fn<NonNullable<BuildDirectorServerOpts['evidenceRefsExistFn']>>()
      .mockRejectedValueOnce(new Error('validator unavailable'))
      .mockResolvedValueOnce(true);
    const h = build({ evidenceRefsExistFn });

    const rejected = await callTool('propose_conjecture', validProposeArgs());
    const retried = await callTool('propose_conjecture', validProposeArgs());

    expect(rejected).toMatchObject({
      ok: false,
      reason: expect.stringContaining('validator unavailable'),
    });
    expect(retried.ok).toBe(true);
    expect(evidenceRefsExistFn).toHaveBeenCalledTimes(2);
    expect(h.proposals).toHaveLength(1);
    expect(h.caps.proposeCount).toBe(1);
  });

  it('retries after concurrent evidence validator throw and failure without stale reservations', async () => {
    let rejectValidation: ((reason: Error) => void) | undefined;
    const blockedValidation = new Promise<boolean>((_resolve, reject) => {
      rejectValidation = reject;
    });
    const evidenceRefsExistFn = vi
      .fn<NonNullable<BuildDirectorServerOpts['evidenceRefsExistFn']>>()
      .mockReturnValueOnce(blockedValidation)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const h = build({
      meetingContext: meetingContext({
        candidate_cells: [cell({ knowledge_id: 'k_throw' }), cell({ knowledge_id: 'k_failure' })],
      }),
      evidenceRefsExistFn,
    });

    const throwing = callTool('propose_conjecture', validProposeArgs({ knowledge_id: 'k_throw' }));
    const failed = callTool('propose_conjecture', validProposeArgs({ knowledge_id: 'k_failure' }));
    rejectValidation?.(new Error('validator unavailable'));

    const [thrownResult, failedResult] = await Promise.all([throwing, failed]);
    expect(thrownResult.ok).toBe(false);
    expect(failedResult.ok).toBe(false);
    expect(h.caps.proposeCount).toBe(0);

    const [retriedThrow, retriedFailure] = await Promise.all([
      callTool('propose_conjecture', validProposeArgs({ knowledge_id: 'k_throw' })),
      callTool('propose_conjecture', validProposeArgs({ knowledge_id: 'k_failure' })),
    ]);
    expect(retriedThrow.ok).toBe(true);
    expect(retriedFailure.ok).toBe(true);
    expect(h.proposals).toHaveLength(2);
    expect(h.caps.proposeCount).toBe(2);
  });

  it('closes the cap/dedup TOCTOU: two "concurrent" propose_conjecture calls for the SAME cell only let ONE land (round-3 review CodeRabbit Major A2)', async () => {
    // Claude can emit multiple tool_use blocks in one turn; if the MCP bridge dispatches
    // them by invoking each handler back-to-back (each handler runs synchronously up to
    // its OWN first `await`, then yields — no preemption mid-synchronous-stretch), the
    // cap/dedup reservation MUST happen before that first await, or both calls' checks
    // race past the gate seeing the SAME stale (not-yet-reserved) state. This test fires
    // both calls WITHOUT awaiting the first before starting the second (matching that
    // dispatch model) and gates getMasteryProjectionFn's await so both calls' synchronous
    // prefixes run to completion before either's async tail resolves.
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const h = build({
      meetingContext: meetingContext({ candidate_cells: [] }), // off-menu → getMasteryProjectionFn IS awaited
      getMasteryProjectionFn: async () => {
        await gate; // block here until the test releases it
        return new Map<string, MasteryProjection>();
      },
    });

    // Fire BOTH calls WITHOUT awaiting the first — each handler's synchronous prefix
    // (including the cap/dedup reservation) runs to completion, back-to-back, before
    // either's async tail (the gated getMasteryProjectionFn call) resolves.
    const first = callTool(
      'propose_conjecture',
      validProposeArgs({ knowledge_id: 'k_race', evidence_refs: ['att_1', 'att_2'] }),
    );
    const second = callTool(
      'propose_conjecture',
      validProposeArgs({ knowledge_id: 'k_race', evidence_refs: ['att_1', 'att_2'] }),
    );

    releaseGate?.();
    const [r1, r2] = await Promise.all([first, second]);

    const oks = [r1, r2].filter((r) => r.ok === true);
    expect(oks).toHaveLength(1); // only ONE actually landed
    expect(h.proposals).toHaveLength(1);
    expect(h.caps.proposeCount).toBe(1); // the reservation was not double-consumed either
  });
});
