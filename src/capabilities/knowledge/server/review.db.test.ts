// KnowledgeReviewTask tests — post Agent SDK migration (2026-05-17).
//
// The pre-migration tests injected a `MockLanguageModelV3` to fake tool-call
// emissions and verified the resulting DB state. After the swap, the
// tool-call loop lives inside the Claude Agent SDK subprocess; we can't
// inject a fake LLM into the subprocess from a unit test.
//
// We instead test:
//   1. `runWriteProposal(db, args)` — the pure dispatch handler — directly.
//      Same DB writes; same edge / tree discrimination; just one level
//      removed from the subprocess.
//   2. System prompt vocabulary (unchanged from pre-migration).
//   3. `streamReviewTask` smoke: mock the Agent SDK module, verify the
//      streamTask wrapper is built with the right MCP server.

import { tasks } from '@/ai/registry';
import { newId } from '@/core/ids';
import { parseEvent } from '@/core/schema/event';
import { ai_task_runs, event, knowledge, knowledge_edge, tool_call_log } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

// Mock the SDK so streamReviewTask doesn't spawn the `claude` binary.
const mockAgentSdk = vi.hoisted(() => ({
  capturedQueryOptions: undefined as unknown,
  capturedQueryPrompt: undefined as unknown,
  capturedMcpServerOptions: undefined as unknown,
  toolDefinitions: [] as Array<{ name: string; description: string }>,
  toolHandlers: [] as Array<
    (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
  >,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt, options }: { prompt: unknown; options: unknown }) => {
    mockAgentSdk.capturedQueryOptions = options;
    mockAgentSdk.capturedQueryPrompt = prompt;
    // Emit a single success result so streamTask completes the stream.
    const iter = (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: '',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    })();
    return iter;
  }),
  createSdkMcpServer: vi.fn((opts: unknown) => {
    mockAgentSdk.capturedMcpServerOptions = opts;
    return { type: 'sdk', name: (opts as { name: string }).name, instance: {} };
  }),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: unknown) => {
    mockAgentSdk.toolDefinitions.push({ name, description });
    mockAgentSdk.toolHandlers.push(
      handler as (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>,
    );
    return { name, description };
  }),
}));

import { runWriteProposal, streamReviewTask } from './review';

describe('KnowledgeReviewTask system prompt', () => {
  it('speaks attempt-event vocabulary + lists propose_knowledge_edge', () => {
    const prompt = tasks.KnowledgeReviewTask.systemPrompt;
    expect(prompt).toContain('attempt event');
    expect(prompt).toContain('propose_knowledge_edge');
    expect(prompt).toContain('relation_type');
  });

  it('registry exposes the MCP-resolved tool name', () => {
    expect(tasks.KnowledgeReviewTask.allowedTools).toEqual(['mcp__loom__write_proposal']);
  });
});

async function seedKnowledgeNode(id: string, domain = 'yuwen') {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: '虚词',
    domain,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedAttemptWithJudge(opts: {
  attemptId: string;
  questionId: string;
  knowledgeIds: string[];
  primary_category?: string;
  analysis_md?: string;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(event).values({
    id: opts.attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: opts.knowledgeIds,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
  await db.insert(event).values({
    id: newId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: opts.attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: opts.primary_category ?? 'concept',
        secondary_categories: [],
        analysis_md: opts.analysis_md ?? 'analysis',
        confidence: 0.8,
      },
      referenced_knowledge_ids: opts.knowledgeIds,
    },
    caused_by_event_id: opts.attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
}

async function seedUserCause(opts: {
  id?: string;
  attemptId: string;
  primary_category: string;
  user_notes?: string | null;
}) {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id ?? newId(),
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:user_cause',
    subject_kind: 'event',
    subject_id: opts.attemptId,
    outcome: null,
    payload: {
      primary_category: opts.primary_category,
      user_notes: opts.user_notes ?? null,
    },
    caused_by_event_id: opts.attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}

describe('runWriteProposal — pure dispatch', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('tree-mutation payload (mutation in payload) writes propose event with knowledge subject', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_parent');

    const result = await runWriteProposal(db, {
      payload: {
        mutation: 'propose_new',
        name: '之-主谓间用法',
        parent_id: 'k_parent',
      },
      reasoning: 'attempt_event_e1 显示用户混淆此用法',
    });
    expect(result.kind).toBe('tree_mutation');
    if (result.kind !== 'tree_mutation') throw new Error(`unexpected kind ${result.kind}`);
    expect(result.proposal_id).toBeTruthy();

    const proposals = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge')));
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload as Record<string, unknown>).name).toBe('之-主谓间用法');
    expect((proposals[0].payload as Record<string, unknown>).parent_id).toBe('k_parent');

    const edgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(edgeEvents).toHaveLength(0);
  });

  it('archive mutation routes through writeKnowledgeProposeEvent (experimental:knowledge_archive)', async () => {
    const db = testDb();
    await seedKnowledgeNode('k1');

    const result = await runWriteProposal(db, {
      payload: { mutation: 'archive', node_id: 'k1', expected_version: 0 },
      reasoning: 'k1 has no recent mistakes; safe to archive',
    });
    expect(result.kind).toBe('tree_mutation');

    const proposeEvents = await db.select().from(event).where(eq(event.actor_ref, 'dreaming'));
    expect(proposeEvents).toHaveLength(1);
    expect(proposeEvents[0].action).toBe('experimental:knowledge_archive');
    const payload = proposeEvents[0].payload as { ai_proposal?: { kind?: string } };
    expect(payload.ai_proposal?.kind).toBe('archive');
  });

  // P5.4 / YUK-143 — an evidence-free legacy MCP edge is rejected by the
  // rubric (isAgent: true) on the RB-4 evidence floor. The
  // event is STILL written, folded with a rubric_verdict marker (RB-6); the
  // ProposeKnowledgeEdge event shape + parseEvent roundtrip are unchanged.
  it('payload-embedded propose_knowledge_edge folds a rubric-rejected ProposeKnowledgeEdge event', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    const now = new Date();
    await testDb().insert(knowledge).values({
      id: 'k_to',
      name: '虚词-之',
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const result = await runWriteProposal(db, {
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: 'k_from',
        to_knowledge_id: 'k_to',
        relation_type: 'prerequisite',
      },
      reasoning: 'attempt_event_e1 显示用户错答指向 k_from 是 k_to 的先决',
    });
    expect(result.kind).toBe('rubric_rejected');
    if (result.kind !== 'rubric_rejected') {
      throw new Error(`expected rubric_rejected, got ${result.kind}`);
    }
    expect(result.event_id).toBeTruthy();
    // Evidence-free agent edge → RB-4 evidence floor.
    expect(result.gate).toBe('evidence_missing');

    const edgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(edgeEvents).toHaveLength(1);
    const ev = edgeEvents[0];
    expect(ev.actor_kind).toBe('agent');
    expect(ev.actor_ref).toBe('dreaming');
    expect(ev.outcome).toBe('success');
    const payload = ev.payload as {
      from_knowledge_id: string;
      to_knowledge_id: string;
      relation_type: string;
      reasoning: string;
      ai_proposal?: { kind?: string };
      rubric_verdict?: { ok?: boolean; gate?: string };
    };
    expect(payload.from_knowledge_id).toBe('k_from');
    expect(payload.to_knowledge_id).toBe('k_to');
    expect(payload.relation_type).toBe('prerequisite');
    expect(payload.reasoning).toContain('先决');
    expect(payload.ai_proposal?.kind).toBe('knowledge_edge');
    // RB-6 — the fold marker rides on the event payload.
    expect(payload.rubric_verdict?.ok).toBe(false);
    expect(payload.rubric_verdict?.gate).toBe('evidence_missing');

    // Roundtrip through Lane B parseEvent — guards schema compatibility.
    const parsed = parseEvent({
      actor_kind: ev.actor_kind,
      actor_ref: ev.actor_ref,
      action: ev.action,
      subject_kind: ev.subject_kind,
      subject_id: ev.subject_id,
      outcome: ev.outcome,
      payload: ev.payload,
      caused_by_event_id: ev.caused_by_event_id ?? undefined,
    }) as { action: string; subject_kind?: string };
    expect(parsed.action).toBe('propose');
    expect(parsed.subject_kind).toBe('knowledge_edge');
  });

  it('writes an evidence-backed maintenance edge as a live proposal with task correlation', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    await seedKnowledgeNode('k_to');
    await seedAttemptWithJudge({
      attemptId: 'attempt_edge_evidence',
      questionId: 'q_edge_evidence',
      knowledgeIds: ['k_from'],
      primary_category: 'concept',
      analysis_md: 'k_from must be understood before k_to',
    });

    const result = await runWriteProposal(
      db,
      {
        payload: {
          mutation: 'propose_knowledge_edge',
          from_knowledge_id: 'k_from',
          to_knowledge_id: 'k_to',
          relation_type: 'prerequisite',
        },
        reasoning:
          'attempt attempt_edge_evidence 的 judge analysis 指向 k_from 是 k_to 的学习前置。',
        evidence_event_ids: ['attempt_edge_evidence'],
      },
      { taskRunId: 'tr_maintenance_edge' },
    );

    expect(result.kind).toBe('knowledge_edge_propose');
    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(rows).toHaveLength(1);
    expect(rows[0].task_run_id).toBe('tr_maintenance_edge');
    expect(rows[0].payload).toMatchObject({
      ai_proposal: {
        evidence_refs: [{ kind: 'event', id: 'attempt_edge_evidence' }],
      },
    });
    expect(rows[0].payload).not.toHaveProperty('rubric_verdict');
  });

  it('folds a fabricated evidence id instead of treating non-empty refs as valid evidence', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    await seedKnowledgeNode('k_to');

    const result = await runWriteProposal(db, {
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: 'k_from',
        to_knowledge_id: 'k_to',
        relation_type: 'prerequisite',
      },
      reasoning: 'attempt fabricated_attempt claims k_from is required before k_to',
      evidence_event_ids: ['fabricated_attempt'],
    });

    expect(result.kind).toBe('rubric_rejected');
    if (result.kind !== 'rubric_rejected') throw new Error(`unexpected kind ${result.kind}`);
    expect(result.gate).toBe('evidence_level');
  });

  it('skips an already-live symmetric edge before pending/rubric gates', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    await seedKnowledgeNode('k_to');
    await db.insert(knowledge_edge).values({
      id: 'edge_live_reverse',
      from_knowledge_id: 'k_to',
      to_knowledge_id: 'k_from',
      relation_type: 'related_to',
      weight: 1,
      created_by: 'user' as never,
      created_at: new Date(),
    });

    const result = await runWriteProposal(db, {
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: 'k_from',
        to_knowledge_id: 'k_to',
        relation_type: 'related_to',
      },
      reasoning: 'already live',
      evidence_event_ids: ['unused_evidence'],
    });

    expect(result).toEqual({
      kind: 'skipped:duplicate_live_edge',
      edge_id: 'edge_live_reverse',
    });
    const proposalRows = await db.select().from(event).where(eq(event.action, 'propose'));
    expect(proposalRows).toHaveLength(0);
  });

  it('skips a reverse pending symmetric edge across legacy directional cooldown keys', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    await seedKnowledgeNode('k_to');
    await writeAiProposal(db, {
      id: 'reverse_pending_edge',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'reverse pending fixture',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k_to',
          to_knowledge_id: 'k_from',
          relation_type: 'contrasts_with',
          weight: 1,
        },
        // Pre-canonical legacy key in the reverse direction.
        cooldown_key: 'knowledge_edge:k_to|k_from|contrasts_with',
      },
    });

    const result = await runWriteProposal(db, {
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: 'k_from',
        to_knowledge_id: 'k_to',
        relation_type: 'contrasts_with',
      },
      reasoning: 'same symmetric edge in the forward direction',
      evidence_event_ids: ['unused_because_gate_short_circuits'],
    });

    expect(result).toMatchObject({
      kind: 'skipped_duplicate',
      proposal_id: 'reverse_pending_edge',
    });
    const edgeProposals = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(edgeProposals).toHaveLength(1);
  });

  it('top-level mutation=propose_knowledge_edge with payload=edge fields routes to ProposeKnowledgeEdge (folded rubric-rejected)', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    const now = new Date();
    await testDb().insert(knowledge).values({
      id: 'k_to',
      name: '虚词-之',
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const result = await runWriteProposal(db, {
      mutation: 'propose_knowledge_edge',
      payload: {
        from_knowledge_id: 'k_from',
        to_knowledge_id: 'k_to',
        relation_type: 'prerequisite',
      },
      reasoning: 'top-level shape',
    });
    // Evidence-free agent edge via the legacy MCP path → rubric-rejected fold.
    expect(result.kind).toBe('rubric_rejected');

    const edgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(edgeEvents).toHaveLength(1);
    expect((edgeEvents[0].payload as { ai_proposal?: { kind?: string } }).ai_proposal?.kind).toBe(
      'knowledge_edge',
    );
  });

  // P5.4 / YUK-143 (RB-7) — legacy-MCP path regression. A folded
  // rubric-rejected proposal on key K must NOT occupy the (kind, cooldown_key)
  // slot for dup-pending dedup: a later evidence-free runWriteProposal on K must
  // NOT come back skipped_duplicate. Both calls deliberately omit
  // evidence_event_ids, so they re-fold rather than becoming live proposals; the
  // load-bearing assertion is simply "not skipped_duplicate".
  // Mirrors the DomainTool RB-7 test for the legacy path.
  it('RB-7 (legacy path): a folded proposal on K does NOT block a later runWriteProposal on K', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    const now = new Date();
    await testDb().insert(knowledge).values({
      id: 'k_to',
      name: '虚词-之',
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const edgeArgs = {
      payload: {
        mutation: 'propose_knowledge_edge' as const,
        from_knowledge_id: 'k_from',
        to_knowledge_id: 'k_to',
        relation_type: 'related_to',
      },
      reasoning: 'attempt_event_e1 显示 k_from 与 k_to 相关',
    };

    const first = await runWriteProposal(db, edgeArgs);
    expect(first.kind).toBe('rubric_rejected');

    // Second call on the SAME key K: the prior fold is terminal, NOT
    // live-pending, so checkProposalGate must NOT short-circuit with
    // skipped_duplicate. It re-folds because this test omits evidence again.
    const second = await runWriteProposal(db, edgeArgs);
    expect(second.kind).not.toBe('skipped_duplicate');
    expect(second.kind).toBe('rubric_rejected');

    // Both folded events exist; neither blocked the other.
    const edgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(edgeEvents).toHaveLength(2);
  });

  it('payload without recognised edge fields falls through to tree path', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_parent');

    await runWriteProposal(db, {
      payload: { mutation: 'archive', node_id: 'k_parent', expected_version: 0 },
      reasoning: 'no top-level mutation; tree mutation lives inside payload',
    });

    const proposeEvents = await db.select().from(event).where(eq(event.actor_ref, 'dreaming'));
    expect(proposeEvents).toHaveLength(1);
    expect(proposeEvents[0].action).toBe('experimental:knowledge_archive');
    const payload = proposeEvents[0].payload as { ai_proposal?: { kind?: string } };
    expect(payload.ai_proposal?.kind).toBe('archive');
  });

  it('skips duplicate pending proposals even when the prior proposal is older than the lookback window', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_parent');
    await writeAiProposal(db, {
      id: 'old_duplicate_p1',
      created_at: new Date('2026-04-01T00:00:00.000Z'),
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'old duplicate',
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: '重复节点',
          parent_id: 'k_parent',
        },
        cooldown_key: 'knowledge_node:k_parent:重复节点',
      },
    });

    const result = await runWriteProposal(db, {
      payload: {
        mutation: 'propose_new',
        name: '重复节点',
        parent_id: 'k_parent',
      },
      reasoning: 'same proposal more than 30 days later',
    });

    expect(result).toMatchObject({
      kind: 'skipped_duplicate',
      proposal_id: 'old_duplicate_p1',
      cooldown_key: 'knowledge_node:k_parent:重复节点',
    });
  });
});

describe('streamReviewTask — SDK wiring smoke', () => {
  beforeEach(async () => {
    await resetDb();
    mockAgentSdk.toolDefinitions = [];
    mockAgentSdk.toolHandlers = [];
    mockAgentSdk.capturedQueryOptions = undefined;
    mockAgentSdk.capturedQueryPrompt = undefined;
    mockAgentSdk.capturedMcpServerOptions = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('builds an MCP server named "loom" with one tool "write_proposal"', async () => {
    const db = testDb();
    await seedKnowledgeNode('k1');
    await seedAttemptWithJudge({
      attemptId: 'attempt_e1',
      questionId: 'q1',
      knowledgeIds: ['k1'],
      primary_category: 'memory',
    });

    const response = await streamReviewTask({ db });
    // Drain the stream so the query iterator completes.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const mcpOpts = mockAgentSdk.capturedMcpServerOptions as { name: string };
    expect(mcpOpts.name).toBe('loom');
    expect(mockAgentSdk.toolDefinitions).toHaveLength(1);
    expect(mockAgentSdk.toolDefinitions[0].name).toBe('write_proposal');

    const queryOpts = mockAgentSdk.capturedQueryOptions as {
      mcpServers?: Record<string, unknown>;
      tools?: string[];
    };
    expect(queryOpts.mcpServers?.loom).toBeTruthy();
    expect(queryOpts.tools).toEqual(['mcp__loom__write_proposal']);
  });

  it('logs a rubric reject once with the real KnowledgeReviewTask run id and output', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    await seedKnowledgeNode('k_to');

    const response = await streamReviewTask({ db });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const handler = mockAgentSdk.toolHandlers[0];
    if (!handler) throw new Error('write_proposal handler not captured');
    const toolResult = await handler({
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: 'k_from',
        to_knowledge_id: 'k_to',
        relation_type: 'prerequisite',
      },
      reasoning: 'attempt missing_evidence is not supplied as evidence',
    });
    expect(JSON.parse(toolResult.content[0]?.text ?? '{}')).toMatchObject({
      kind: 'rubric_rejected',
      gate: 'evidence_missing',
    });

    const runs = await db
      .select({ id: ai_task_runs.id })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.task_kind, 'KnowledgeReviewTask'));
    expect(runs).toHaveLength(1);
    const logs = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.tool_name, 'mcp__loom__write_proposal'));
    expect(logs).toHaveLength(1);
    expect(logs[0].task_run_id).toBe(runs[0].id);
    expect(logs[0].effect).toBe('propose');
    expect(logs[0].error_reason).toBeNull();
    expect(logs[0].output_json).toMatchObject({
      kind: 'rubric_rejected',
      gate: 'evidence_missing',
    });
  });

  it('passes recent-mistakes shape projected from event stream into the prompt', async () => {
    const db = testDb();
    await seedKnowledgeNode('k1');
    await seedAttemptWithJudge({
      attemptId: 'attempt_capture',
      questionId: 'q_capture',
      knowledgeIds: ['k1'],
      primary_category: 'concept',
      analysis_md: 'event-stream analysis',
    });

    const response = await streamReviewTask({ db });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const promptStr = JSON.stringify(mockAgentSdk.capturedQueryPrompt ?? '');
    expect(promptStr).toContain('attempt_capture');
    expect(promptStr).toContain('q_capture');
    expect(promptStr).toContain('concept');
  });

  it('passes active user cause to KnowledgeReviewTask instead of the agent judge cause', async () => {
    const db = testDb();
    await seedKnowledgeNode('k1');
    await seedAttemptWithJudge({
      attemptId: 'attempt_user_cause',
      questionId: 'q_user_cause',
      knowledgeIds: ['k1'],
      primary_category: 'concept',
      analysis_md: 'agent-only analysis',
    });
    await seedUserCause({
      attemptId: 'attempt_user_cause',
      primary_category: 'memory',
      user_notes: '用户确认是记忆问题',
    });

    const response = await streamReviewTask({ db });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const promptStr = String(mockAgentSdk.capturedQueryPrompt ?? '');
    expect(promptStr).toContain('attempt_user_cause');
    expect(promptStr).toContain('"source":"user"');
    expect(promptStr).toContain('memory');
    expect(promptStr).not.toContain('agent-only analysis');
  });

  it('passes the dominant tree subject profile into KnowledgeReviewTask', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_math', 'math');

    const response = await streamReviewTask({ db });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const queryOpts = mockAgentSdk.capturedQueryOptions as { systemPrompt?: string };
    expect(queryOpts.systemPrompt).toContain('科目上下文：数学');
    expect(queryOpts.systemPrompt).not.toContain('文言文');
  });
});
