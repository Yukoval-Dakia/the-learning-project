// YUK-572 PR-1 — evidence MCP db test. Real Postgres (testcontainer); the SDK is
// mocked so the tool() factory captures each handler and we invoke it directly against
// seeded rows (no `claude` subprocess). Asserts: correct tool registration, per-tool
// query shape + ROW/CHAR bounds, <untrusted_learner_text> delimiting, get_agent_notes
// self-source exclusion, toolTrace capture order, report_findings capture, and
// persistToolTrace → tool_call_log (effect 'read', cost 0).

import { writeAgentNote } from '@/capabilities/agency/server/notes';
import { event, kc_typed_state, question, tool_call_log } from '@/db/schema';
import { artifact } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

// Capture the registered tool handlers + names via a mocked SDK.
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

import { EVIDENCE_LIMITS, buildEvidenceServer, persistToolTrace } from './evidence-mcp';
import type { EvidenceServer } from './evidence-mcp';
import { createFindingsCapture } from './report-findings';
import type { FindingsCapture } from './report-findings';
import { EVIDENCE_READ_TOOL_LOCAL_NAMES } from './tool-names';

const NOW = new Date('2026-07-06T00:00:00.000Z');
const SELF_KIND = 'research_meeting_agent';

let capture: FindingsCapture;
let evidence: EvidenceServer;

async function callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
  const handler = mockSdk.handlers.get(name);
  if (!handler) throw new Error(`no registered handler for ${name}`);
  const res = await handler(args);
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

async function seedFailureAttempt(opts: {
  id: string;
  questionId: string;
  answerMd: string;
  knowledgeIds: string[];
}): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id: opts.id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: opts.questionId,
      outcome: 'failure',
      payload: {
        answer_md: opts.answerMd,
        answer_image_refs: [],
        referenced_knowledge_ids: opts.knowledgeIds,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: NOW,
    });
}

beforeEach(async () => {
  await resetDb();
  mockSdk.handlers.clear();
  mockSdk.registeredNames = [];
  mockSdk.serverName = undefined;
  capture = createFindingsCapture();
  evidence = buildEvidenceServer({
    db: testDb(),
    now: NOW,
    selfSourceKind: SELF_KIND,
    capture,
  });
});

describe('buildEvidenceServer — registration', () => {
  it('registers under research_evidence with 6 read + get_traces + report_findings', () => {
    expect(mockSdk.serverName).toBe('research_evidence');
    expect(mockSdk.registeredNames).toEqual([
      ...EVIDENCE_READ_TOOL_LOCAL_NAMES,
      'get_traces',
      'report_findings',
    ]);
  });
});

describe('get_attempt_details', () => {
  it('returns the attempt with answer_md wrapped + truncated to the char bound', async () => {
    const longAnswer = 'x'.repeat(EVIDENCE_LIMITS.attemptTextChars + 500);
    await seedFailureAttempt({
      id: 'attempt_1',
      questionId: 'q1',
      answerMd: longAnswer,
      knowledgeIds: ['k1', 'k2'],
    });

    const out = await callTool('get_attempt_details', { attempt_event_id: 'attempt_1' });
    expect(out.found).toBe(true);
    expect(out.question_id).toBe('q1');
    expect(out.referenced_knowledge_ids).toEqual(['k1', 'k2']);
    const answer = out.answer_md as string;
    expect(answer.startsWith('<untrusted_learner_text>')).toBe(true);
    expect(answer.endsWith('</untrusted_learner_text>')).toBe(true);
    // Inner text truncated to the char bound (delimiters add fixed overhead).
    const inner = answer
      .replace('<untrusted_learner_text>', '')
      .replace('</untrusted_learner_text>', '');
    expect(inner).toHaveLength(EVIDENCE_LIMITS.attemptTextChars);
  });

  it('returns found:false for a missing attempt', async () => {
    const out = await callTool('get_attempt_details', { attempt_event_id: 'nope' });
    expect(out.found).toBe(false);
  });

  it('records a toolTrace entry with the attempt id', async () => {
    await seedFailureAttempt({
      id: 'attempt_2',
      questionId: 'q1',
      answerMd: 'a',
      knowledgeIds: ['k1'],
    });
    await callTool('get_attempt_details', { attempt_event_id: 'attempt_2' });
    const trace = evidence.readToolTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0].tool).toBe('get_attempt_details');
    expect(trace[0].returned_ids).toContain('attempt_2');
  });
});

describe('get_question', () => {
  it('returns the question with prompt/reference wrapped + truncated', async () => {
    const longPrompt = 'p'.repeat(EVIDENCE_LIMITS.questionTextChars + 100);
    await testDb()
      .insert(question)
      .values({
        id: 'q1',
        kind: 'short_answer',
        prompt_md: longPrompt,
        reference_md: 'ref',
        knowledge_ids: ['k1'],
        source: 'test',
        created_at: NOW,
        updated_at: NOW,
      });

    const out = await callTool('get_question', { question_id: 'q1' });
    expect(out.found).toBe(true);
    expect(out.kind).toBe('short_answer');
    const prompt = out.prompt_md as string;
    expect(prompt.startsWith('<untrusted_learner_text>')).toBe(true);
    const inner = prompt
      .replace('<untrusted_learner_text>', '')
      .replace('</untrusted_learner_text>', '');
    expect(inner).toHaveLength(EVIDENCE_LIMITS.questionTextChars);
    expect(out.reference_md).toBe('<untrusted_learner_text>ref</untrusted_learner_text>');
  });

  it('returns found:false for a missing question', async () => {
    const out = await callTool('get_question', { question_id: 'ghost' });
    expect(out.found).toBe(false);
  });
});

describe('get_probe_history', () => {
  it('returns newest-first, capped at the row bound, filtered by knowledge_id', async () => {
    const rows = [];
    for (let i = 0; i < EVIDENCE_LIMITS.probeHistoryRows + 5; i++) {
      rows.push({
        id: `ps_${i}`,
        session_id: null,
        actor_kind: 'agent' as const,
        actor_ref: 'reconcile',
        action: 'experimental:prediction_score',
        subject_kind: 'query',
        subject_id: `ps_${i}`,
        outcome: null,
        payload: { knowledge_id: 'k1', score: i },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(NOW.getTime() + i * 1000),
      });
    }
    // A different KC's probe must be excluded.
    rows.push({
      id: 'ps_other',
      session_id: null,
      actor_kind: 'agent' as const,
      actor_ref: 'reconcile',
      action: 'experimental:prediction_score',
      subject_kind: 'query',
      subject_id: 'ps_other',
      outcome: null,
      payload: { knowledge_id: 'k2', score: 99 },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(NOW.getTime() + 999_000),
    });
    await testDb().insert(event).values(rows);

    const out = await callTool('get_probe_history', { knowledge_id: 'k1' });
    const probes = out.probes as Array<{ event_id: string; payload: { knowledge_id: string } }>;
    expect(probes).toHaveLength(EVIDENCE_LIMITS.probeHistoryRows);
    // Newest first: the highest-index (latest created_at) k1 row leads.
    expect(probes[0].event_id).toBe(`ps_${EVIDENCE_LIMITS.probeHistoryRows + 4}`);
    // k2 never leaks in.
    expect(probes.every((p) => p.payload.knowledge_id === 'k1')).toBe(true);
  });
});

describe('get_typed_state', () => {
  it('returns the typed-state row for the knowledge id', async () => {
    await testDb()
      .insert(kc_typed_state)
      .values({
        id: 'kts_1',
        subject_kind: 'knowledge',
        subject_id: 'k1',
        typed_state: 'confused-with-X',
        confused_with_kc_id: 'k2',
        lifecycle: 'open',
        evidence_event_ids: ['e1'],
        last_evidence_at: NOW,
        updated_at: NOW,
      });

    const out = await callTool('get_typed_state', { knowledge_id: 'k1' });
    const states = out.typed_states as Array<{ typed_state: string; confused_with_kc_id: string }>;
    expect(states).toHaveLength(1);
    expect(states[0].typed_state).toBe('confused-with-X');
    expect(states[0].confused_with_kc_id).toBe('k2');
  });
});

describe('get_notes', () => {
  it('returns note summaries capped at the summary bound', async () => {
    const rows = [];
    for (let i = 0; i < EVIDENCE_LIMITS.noteSummaries + 3; i++) {
      rows.push({
        id: `note_${i}`,
        type: 'note_atomic',
        title: `note ${i}`,
        intent_source: 'test',
        source: 'test',
        knowledge_ids: ['k1'],
        created_at: new Date(NOW.getTime() + i * 1000),
        updated_at: NOW,
      });
    }
    await testDb().insert(artifact).values(rows);

    const out = await callTool('get_notes', { knowledge_id: 'k1' });
    const notes = out.notes as Array<{ id: string }>;
    expect(notes).toHaveLength(EVIDENCE_LIMITS.noteSummaries);
  });
});

describe('get_agent_notes', () => {
  it('excludes the caller own source kind (self-reinforcement guard) + traces', async () => {
    const db = testDb();
    const future = new Date(NOW.getTime() + 30 * 24 * 3600 * 1000).toISOString();
    // Self note — must be excluded.
    await writeAgentNote(db, {
      target_agents: ['research_meeting'],
      source_task_kind: SELF_KIND,
      refs: [],
      summary_md: 'my own old conclusion',
      signal_kind: 'conjecture_deep_dive',
      expires_at: future,
    });
    // Other-agent note — must be returned.
    const otherId = await writeAgentNote(db, {
      target_agents: ['research_meeting'],
      source_task_kind: 'dreaming',
      refs: [],
      summary_md: 'dreaming observation',
      signal_kind: 'attention',
      expires_at: future,
    });

    const out = await callTool('get_agent_notes', {});
    const notes = out.agent_notes as Array<{ id: string; source_task_kind: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(otherId);
    expect(notes[0].source_task_kind).toBe('dreaming');

    const trace = evidence.readToolTrace();
    expect(trace[0].tool).toBe('get_agent_notes');
    expect(trace[0].returned_ids).toEqual([otherId]);
  });
});

describe('get_traces', () => {
  it('returns the YUK-562 placeholder without touching the DB', async () => {
    const out = await callTool('get_traces', { knowledge_id: 'k1' });
    expect(out).toEqual({ available: false, reason: 'traces reader lands with YUK-562' });
  });
});

describe('report_findings', () => {
  it('captures a valid findings object into the capture ref', async () => {
    const findings = {
      single_or_multi_mechanism: 'single',
      evidence_attribution_contradiction: 'none',
      suggested_probe_angle: 'probe the edge case',
      findings_md: 'the learner conflates X with Y',
      evidence_refs: ['attempt_1'],
      confidence: 0.5,
    };
    const out = await callTool('report_findings', findings);
    expect(out.ok).toBe(true);
    expect(capture.value).toEqual(findings);
  });

  it('rejects invalid findings and leaves the capture null', async () => {
    const out = await callTool('report_findings', {
      single_or_multi_mechanism: 'nonsense',
      evidence_attribution_contradiction: 'none',
      suggested_probe_angle: 'x',
      findings_md: 'y',
      evidence_refs: [],
      confidence: 0.4,
    });
    expect(out.ok).toBe(false);
    expect(capture.value).toBeNull();
  });
});

describe('persistToolTrace', () => {
  it('writes one tool_call_log row per trace entry (effect read, cost 0)', async () => {
    const db = testDb();
    await seedFailureAttempt({
      id: 'attempt_1',
      questionId: 'q1',
      answerMd: 'a',
      knowledgeIds: ['k1'],
    });
    await callTool('get_attempt_details', { attempt_event_id: 'attempt_1' });
    await callTool('get_typed_state', { knowledge_id: 'k1' });

    const trace = evidence.readToolTrace();
    expect(trace).toHaveLength(2);

    await persistToolTrace(db, trace, {
      taskRunId: 'run_synthetic_1',
      taskKind: 'ResearchMeetingDirectorTask',
    });

    const logs = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, 'run_synthetic_1'));
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.effect).toBe('read');
      expect(log.cost).toBe(0);
      expect(log.task_kind).toBe('ResearchMeetingDirectorTask');
    }
    const toolNames = logs.map((l) => l.tool_name).sort();
    expect(toolNames).toEqual(['get_attempt_details', 'get_typed_state']);
  });
});
