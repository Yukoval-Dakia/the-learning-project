// YUK-572 PR-2 — director write-face MCP server unit tests. Pure, no DB: the SDK is
// mocked so the tool() factory captures each handler and we invoke it directly with
// injected fake writers. Asserts the server-side single-writer discipline:
// propose_conjecture cap / pending-dedup / Zod / baseline_p auto-snapshot, and
// leave_agent_note cap / target whitelist / summary truncation / primary-ref filter.

import type { WriteAgentNoteInput } from '@/capabilities/agency/server/notes';
import { conjectureKey } from '@/server/conjectures/evidence';
import type { MasteryProjection } from '@/server/mastery/state';
import type { WriteAiProposalInput } from '@/server/proposals/writer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the registered tool handlers via a mocked SDK (same shape as evidence-mcp.db.test).
const mockSdk = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (args: unknown) => Promise<{ content: { type: string; text: string }[] }>
  >(),
  registeredNames: [] as string[],
  serverName: undefined as string | undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: { name: string; tools: unknown[] }) => {
    mockSdk.serverName = opts.name;
    return { type: 'sdk', name: opts.name, instance: {} };
  }),
  tool: vi.fn(
    (
      name: string,
      _desc: string,
      _schema: unknown,
      handler: (args: unknown) => Promise<{ content: { type: string; text: string }[] }>,
    ) => {
      mockSdk.handlers.set(name, handler);
      mockSdk.registeredNames.push(name);
      return { name };
    },
  ),
}));

import {
  type BuildDirectorServerOpts,
  DIRECTOR_ALLOWED_TOOLS,
  DIRECTOR_FIXED_CONFIDENCE,
  DIRECTOR_MAX_NOTES,
  DIRECTOR_MAX_PROPOSALS,
  DIRECTOR_NOTE_SUMMARY_MAX_CHARS,
  type MeetingContext,
  RESEARCH_MEETING_AGENT_ACTOR,
  buildDirectorServer,
  createDirectorCaps,
} from './director-tools';

const NOW = new Date('2026-07-06T00:00:00.000Z');

async function callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
  const handler = mockSdk.handlers.get(name);
  if (!handler) throw new Error(`no registered handler for ${name}`);
  const res = await handler(args);
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
    probe_md: '给出一个只有该误解才会答错的判别题',
    probe_reference_md: '参考答案：必要不充分的反例',
    predicted_p: 0.3,
    discriminating: true,
    evidence_refs: ['att_1', 'att_2'],
    ...overrides,
  };
}

interface Harness {
  proposals: WriteAiProposalInput[];
  notes: WriteAgentNoteInput[];
  caps: ReturnType<typeof createDirectorCaps>;
}

function build(opts: Partial<BuildDirectorServerOpts> = {}): Harness {
  mockSdk.handlers.clear();
  mockSdk.registeredNames.length = 0;
  const proposals: WriteAiProposalInput[] = [];
  const notes: WriteAgentNoteInput[] = [];
  const caps = createDirectorCaps();
  buildDirectorServer({
    db: {} as never,
    now: NOW,
    meetingContext: meetingContext(),
    knownConjectureKeys: new Set<string>(),
    caps,
    triggerEventId: 'trigger_1',
    toolContextTaskRunId: 'toolrun_1',
    writeAiProposalFn: async (_db, input) => {
      proposals.push(input);
      return `prop_${proposals.length}`;
    },
    writeAgentNoteFn: async (_db, input) => {
      notes.push(input);
      return `agent_note_${notes.length}`;
    },
    getMasteryProjectionFn: async () => new Map<string, MasteryProjection>(),
    ...opts,
  });
  return { proposals, notes, caps };
}

beforeEach(() => {
  mockSdk.handlers.clear();
  mockSdk.registeredNames.length = 0;
});

describe('buildDirectorServer — registration', () => {
  it('registers get_meeting_context + propose_conjecture + leave_agent_note on the director server', () => {
    build();
    expect(mockSdk.serverName).toBe('research_meeting_director');
    expect(mockSdk.registeredNames).toEqual([
      'get_meeting_context',
      'propose_conjecture',
      'leave_agent_note',
    ]);
  });

  it('DIRECTOR_ALLOWED_TOOLS lists Task literally (Options.tools is a restrictive allowlist)', () => {
    // Options.tools is a WHITELIST: if 'Task' is missing the spawn is blocked even
    // though agents{} defines the scout (§9 / Lens A #6, E-1). Pin the literal.
    expect(DIRECTOR_ALLOWED_TOOLS).toContain('Task');
    // the director sees the 6 read tools + the two write tools + get_meeting_context.
    expect(DIRECTOR_ALLOWED_TOOLS).toContain('mcp__research_evidence__get_attempt_details');
    expect(DIRECTOR_ALLOWED_TOOLS).toContain('mcp__research_meeting_director__get_meeting_context');
    expect(DIRECTOR_ALLOWED_TOOLS).toContain('mcp__research_meeting_director__propose_conjecture');
    expect(DIRECTOR_ALLOWED_TOOLS).toContain('mcp__research_meeting_director__leave_agent_note');
  });
});

describe('get_meeting_context', () => {
  it('returns the precomputed snapshot (candidate cells are material, not orders)', async () => {
    build();
    const res = await callTool('get_meeting_context', {});
    expect(res.recent_failure_summary).toMatchObject({ window_days: 14 });
    const cells = res.candidate_cells as Array<Record<string, unknown>>;
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ knowledge_id: 'k_a', baseline_p: 0.42 });
  });
});

describe('propose_conjecture — server-enforced single writer', () => {
  it('writes a propose-only mind_model payload: actor_ref, provenance, baseline snapshot, fixed confidence', async () => {
    const h = build();
    const res = await callTool('propose_conjecture', validProposeArgs());
    expect(res.ok).toBe(true);
    expect(h.proposals).toHaveLength(1);
    const input = h.proposals[0];
    expect(input.actor_ref).toBe(RESEARCH_MEETING_AGENT_ACTOR);
    expect(input.caused_by_event_id).toBe('trigger_1');
    expect(input.task_run_id).toBe('toolrun_1');
    expect(input.cost_usd).toBe(0); // cost rides the director run's scan event, not proposals
    if (input.payload.kind !== 'conjecture') throw new Error('kind narrowing');
    expect(input.payload.target.subject_kind).toBe('mind_model');
    expect(input.payload.target.subject_id).toBe('k_a');
    expect(input.payload.evidence_refs).toEqual([
      { kind: 'event', id: 'att_1' },
      { kind: 'event', id: 'att_2' },
    ]);
    const change = input.payload.proposed_change;
    expect(change.knowledge_id).toBe('k_a');
    expect(change.cause_category).toBe('concept_confusion');
    expect(change.baseline_p_at_induction).toBe(0.42); // server-snapshotted from the cell
    expect(change.confidence).toBe(DIRECTOR_FIXED_CONFIDENCE); // fixed, never LLM-reported
    expect(change.recurrence_count).toBe(3); // from the matching cell
    expect(change.corrected_by_owner).toBe(false);
  });

  it('caps at DIRECTOR_MAX_PROPOSALS per run (soft stop, does not write beyond the cap)', async () => {
    const h = build({
      meetingContext: meetingContext({
        candidate_cells: [
          cell({ knowledge_id: 'k_a' }),
          cell({ knowledge_id: 'k_b' }),
          cell({ knowledge_id: 'k_c' }),
          cell({ knowledge_id: 'k_d' }),
        ],
      }),
    });
    for (const kc of ['k_a', 'k_b', 'k_c']) {
      const res = await callTool('propose_conjecture', validProposeArgs({ knowledge_id: kc }));
      expect(res.ok).toBe(true);
    }
    const capped = await callTool('propose_conjecture', validProposeArgs({ knowledge_id: 'k_d' }));
    expect(capped.ok).toBe(false);
    expect(String(capped.reason)).toMatch(/上限/);
    expect(h.proposals).toHaveLength(DIRECTOR_MAX_PROPOSALS);
  });

  it('dedups against a pending conjecture (dedup base is ALL pending, cross-actor)', async () => {
    const h = build({
      knownConjectureKeys: new Set([conjectureKey('concept_confusion', 'k_a')]),
    });
    const res = await callTool('propose_conjecture', validProposeArgs());
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/已有 pending|已有|pending/);
    expect(h.proposals).toHaveLength(0);
  });

  it('dedups a second same-cell proposal within one run', async () => {
    const h = build();
    const first = await callTool('propose_conjecture', validProposeArgs());
    expect(first.ok).toBe(true);
    const second = await callTool('propose_conjecture', validProposeArgs());
    expect(second.ok).toBe(false);
    expect(h.proposals).toHaveLength(1);
  });

  it('rejects (does not consume the cap) when claim_md exceeds the 280-char ConjectureDraft cap', async () => {
    const h = build();
    const res = await callTool(
      'propose_conjecture',
      validProposeArgs({ claim_md: '误'.repeat(281) }),
    );
    expect(res.ok).toBe(false);
    expect(h.proposals).toHaveLength(0);
    expect(h.caps.proposeCount).toBe(0); // a rejected proposal never consumes a cap slot
  });

  it('rejects when no first-hand evidence ref survives the agent_note filter', async () => {
    const h = build();
    const res = await callTool(
      'propose_conjecture',
      validProposeArgs({ evidence_refs: ['agent_note_abc', 'agent_note_def'] }),
    );
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/一手证据|first-hand|证据/);
    expect(h.proposals).toHaveLength(0);
  });

  it('snapshots baseline_p to the cold-start neutral 0.5 for a KC absent from cells + mastery', async () => {
    const h = build({
      meetingContext: meetingContext({ candidate_cells: [] }),
      getMasteryProjectionFn: async () => new Map<string, MasteryProjection>(),
    });
    const res = await callTool('propose_conjecture', validProposeArgs({ knowledge_id: 'k_cold' }));
    expect(res.ok).toBe(true);
    if (h.proposals[0].payload.kind !== 'conjecture') throw new Error('kind narrowing');
    expect(h.proposals[0].payload.proposed_change.baseline_p_at_induction).toBe(0.5);
  });

  it('rejects a malformed cause_category (uppercase/space) BEFORE it can compute a mismatched dedup key (§7 review MINOR #6)', async () => {
    const h = build();
    const res = await callTool(
      'propose_conjecture',
      validProposeArgs({ cause_category: 'Concept Confusion' }),
    );
    expect(res.ok).toBe(false);
    expect(h.proposals).toHaveLength(0);
    expect(h.caps.proposeCount).toBe(0); // rejected, cap not consumed
  });

  it('rejects an off-menu proposal with <2 first-hand refs with a HUMAN-READABLE reason, not a raw Zod dump (§7 review MINOR #7)', async () => {
    const h = build({ meetingContext: meetingContext({ candidate_cells: [] }) }); // no matching cell
    const res = await callTool(
      'propose_conjecture',
      validProposeArgs({ knowledge_id: 'k_offmenu', evidence_refs: ['att_only_one'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('证据不足需≥2条一手证据，请补充或另选候选单元');
    expect(res.issues).toBeUndefined(); // no raw Zod issues dump
    expect(h.proposals).toHaveLength(0);
  });

  it('rejects evidence_refs beyond the 12-item bound (round-2 review MINOR #5 — mirrors scout report_findings.max(12))', async () => {
    const h = build();
    const tooMany = Array.from({ length: 13 }, (_, i) => `att_${i}`);
    const res = await callTool('propose_conjecture', validProposeArgs({ evidence_refs: tooMany }));
    expect(res.ok).toBe(false);
    expect(h.proposals).toHaveLength(0);
  });

  it('does NOT reject a proposal at exactly the 12-ref bound', async () => {
    const h = build();
    const twelve = Array.from({ length: 12 }, (_, i) => `att_${i}`);
    const res = await callTool('propose_conjecture', validProposeArgs({ evidence_refs: twelve }));
    expect(res.ok).toBe(true);
    expect(h.proposals).toHaveLength(1);
  });

  it('falls back to baseline_p=0.5 (does NOT reject the proposal) when getMasteryProjectionFn throws (round-2 review MAJOR #3)', async () => {
    const h = build({
      meetingContext: meetingContext({ candidate_cells: [] }), // no matching cell → live mastery read attempted
      getMasteryProjectionFn: async () => {
        throw new Error('mastery projection DB read blew up');
      },
    });
    const res = await callTool(
      'propose_conjecture',
      validProposeArgs({ knowledge_id: 'k_read_fail' }),
    );
    expect(res.ok).toBe(true); // a read failure is NOT a reason to reject an otherwise-valid proposal
    expect(h.proposals).toHaveLength(1);
    if (h.proposals[0].payload.kind !== 'conjecture') throw new Error('kind narrowing');
    expect(h.proposals[0].payload.proposed_change.baseline_p_at_induction).toBe(0.5);
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

describe('leave_agent_note — server-enforced', () => {
  function validNoteArgs(overrides: Record<string, unknown> = {}) {
    return {
      target_agents: ['dreaming'],
      signal_kind: 'misconception_watch',
      summary_md: 'owner 反复在必要/充分上出错，dreaming 关注该 KC',
      refs: [{ kind: 'event', id: 'att_1' }],
      ...overrides,
    };
  }

  it('writes a research_meeting_agent-sourced note with 30-day expiry + trigger provenance', async () => {
    const h = build();
    const res = await callTool('leave_agent_note', validNoteArgs());
    expect(res.ok).toBe(true);
    expect(h.notes).toHaveLength(1);
    const note = h.notes[0];
    expect(note.source_task_kind).toBe(RESEARCH_MEETING_AGENT_ACTOR);
    expect(note.source_task_run_id).toBe('toolrun_1');
    expect(note.caused_by_event_id).toBe('trigger_1');
    expect(note.target_agents).toEqual(['dreaming']);
    expect(note.expires_at).toBeDefined();
  });

  it('caps at DIRECTOR_MAX_NOTES per run', async () => {
    const h = build();
    await callTool('leave_agent_note', validNoteArgs());
    await callTool('leave_agent_note', validNoteArgs());
    const capped = await callTool('leave_agent_note', validNoteArgs());
    expect(capped.ok).toBe(false);
    expect(h.notes).toHaveLength(DIRECTOR_MAX_NOTES);
  });

  it('rejects a target_agent outside the whitelist', async () => {
    const h = build();
    const res = await callTool('leave_agent_note', validNoteArgs({ target_agents: ['attacker'] }));
    expect(res.ok).toBe(false);
    expect(h.notes).toHaveLength(0);
  });

  it('truncates summary_md to the 1200-char bound', async () => {
    const h = build();
    const res = await callTool('leave_agent_note', validNoteArgs({ summary_md: 'x'.repeat(2000) }));
    expect(res.ok).toBe(true);
    expect(h.notes[0].summary_md.length).toBe(DIRECTOR_NOTE_SUMMARY_MAX_CHARS);
  });

  it('filters agent_note refs out of the note evidence (primary refs only)', async () => {
    const h = build();
    await callTool(
      'leave_agent_note',
      validNoteArgs({
        refs: [
          { kind: 'event', id: 'att_1' },
          { kind: 'event', id: 'agent_note_bad' },
        ],
      }),
    );
    expect(h.notes[0].refs).toEqual([{ kind: 'event', id: 'att_1' }]);
  });

  it('soft-rejects when writeAgentNoteFn throws (DB write failure) — noteCount does not advance (§7 review MAJOR #4)', async () => {
    const h = build({
      writeAgentNoteFn: async () => {
        throw new Error('db write blew up');
      },
    });
    const res = await callTool('leave_agent_note', validNoteArgs());
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/写入被拒|failed|error/i);
    expect(h.notes).toHaveLength(0);
    expect(h.caps.noteCount).toBe(0);
  });

  // Round-2 review MINOR #6 — spec judgment (spec line 276): leave_agent_note's refs
  // spec bullet says only "refs 经 assertPrimaryEvidenceRefs" — NO explicit reject-if-
  // empty clause, unlike propose_conjecture's bullet (spec line 265: "过滤后为空 →
  // 拒绝"). Notes are soft hints (notes.ts: "HINTS, NOT FACTS"), not accountable
  // falsifiable claims, so a genuinely-empty-from-the-start refs[] (a pure textual
  // "watch this KC" hint with zero evidence) is a LEGITIMATE input per spec. The only
  // thing that should be rejected is the OCR-flagged case: refs WAS non-empty but every
  // entry got filtered out as an agent_note id (that's suspicious — the director tried
  // to cite "evidence" that was entirely soft hints masquerading as primary).
  it('accepts a genuinely empty refs[] (a pure no-evidence soft hint — legitimate per spec §5)', async () => {
    const h = build();
    const res = await callTool('leave_agent_note', validNoteArgs({ refs: [] }));
    expect(res.ok).toBe(true);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].refs).toEqual([]);
  });

  it('rejects when refs was non-empty but EVERY entry filtered out as agent_note ids (round-2 review MINOR #6)', async () => {
    const h = build();
    const res = await callTool(
      'leave_agent_note',
      validNoteArgs({
        refs: [
          { kind: 'event', id: 'agent_note_a' },
          { kind: 'event', id: 'agent_note_b' },
        ],
      }),
    );
    expect(res.ok).toBe(false);
    expect(h.notes).toHaveLength(0);
    expect(h.caps.noteCount).toBe(0);
  });
});
