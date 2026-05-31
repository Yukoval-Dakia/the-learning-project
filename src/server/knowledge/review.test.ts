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
import { event, knowledge } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

// Mock the SDK so streamReviewTask doesn't spawn the `claude` binary.
const mockAgentSdk = vi.hoisted(() => ({
  capturedQueryOptions: undefined as unknown,
  capturedQueryPrompt: undefined as unknown,
  capturedMcpServerOptions: undefined as unknown,
  toolDefinitions: [] as Array<{ name: string; description: string }>,
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
  tool: vi.fn((name: string, description: string, _schema: unknown, _handler: unknown) => {
    mockAgentSdk.toolDefinitions.push({ name, description });
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

async function seedKnowledgeNode(id: string, domain = 'wenyan') {
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

  // P5.4 / YUK-143 — the legacy MCP edge path attaches no evidence_event_ids,
  // so the rubric (isAgent: true) rejects it on the RB-4 evidence floor. The
  // event is STILL written, folded with a rubric_verdict marker (RB-6); the
  // ProposeKnowledgeEdge event shape + parseEvent roundtrip are unchanged.
  it('payload-embedded propose_knowledge_edge folds a rubric-rejected ProposeKnowledgeEdge event', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    const now = new Date();
    await testDb().insert(knowledge).values({
      id: 'k_to',
      name: '虚词-之',
      domain: 'wenyan',
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

  it('top-level mutation=propose_knowledge_edge with payload=edge fields routes to ProposeKnowledgeEdge (folded rubric-rejected)', async () => {
    const db = testDb();
    await seedKnowledgeNode('k_from');
    const now = new Date();
    await testDb().insert(knowledge).values({
      id: 'k_to',
      name: '虚词-之',
      domain: 'wenyan',
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
