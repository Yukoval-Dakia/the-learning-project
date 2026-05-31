// Phase 2 Dreaming — knowledge_edge nightly propose tests.

import { tasks } from '@/ai/registry';
import { cost_ledger, event, knowledge, knowledge_edge } from '@/db/schema';
import type { FailureAttempt } from '@/server/events/queries';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { parseEdgeProposeOutput, runEdgeProposeAndWrite } from './propose_edge';

describe('KnowledgeEdgeProposeTask system prompt', () => {
  it('talks edge vocabulary', () => {
    const p = tasks.KnowledgeEdgeProposeTask.systemPrompt;
    expect(p).toContain('knowledge_edge');
    expect(p).toContain('relation_type');
    expect(p).toContain('prerequisite');
  });
});

describe('parseEdgeProposeOutput', () => {
  it('parses well-formed JSON with proposals array', () => {
    const text =
      '{"proposals":[{"from_knowledge_id":"k1","to_knowledge_id":"k2","relation_type":"prerequisite","weight":0.6,"reasoning":"r"}]}';
    const out = parseEdgeProposeOutput(text);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].relation_type).toBe('prerequisite');
  });

  it('accepts experimental:* relation_type', () => {
    const text =
      '{"proposals":[{"from_knowledge_id":"k1","to_knowledge_id":"k2","relation_type":"experimental:syntax_mirror","weight":0.5,"reasoning":"r"}]}';
    const out = parseEdgeProposeOutput(text);
    expect(out.proposals[0].relation_type).toBe('experimental:syntax_mirror');
  });

  it('rejects unknown relation_type (no experimental: prefix, not in 5 core)', () => {
    const text =
      '{"proposals":[{"from_knowledge_id":"k1","to_knowledge_id":"k2","relation_type":"some_other","weight":0.5,"reasoning":"r"}]}';
    expect(() => parseEdgeProposeOutput(text)).toThrow();
  });

  it('rejects weight outside [0,1]', () => {
    const text =
      '{"proposals":[{"from_knowledge_id":"k1","to_knowledge_id":"k2","relation_type":"prerequisite","weight":1.5,"reasoning":"r"}]}';
    expect(() => parseEdgeProposeOutput(text)).toThrow();
  });

  it('rejects empty reasoning', () => {
    const text =
      '{"proposals":[{"from_knowledge_id":"k1","to_knowledge_id":"k2","relation_type":"prerequisite","weight":0.5,"reasoning":""}]}';
    expect(() => parseEdgeProposeOutput(text)).toThrow();
  });

  it('caps proposals at 5', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      from_knowledge_id: `k${i}a`,
      to_knowledge_id: `k${i}b`,
      relation_type: 'related_to',
      weight: 0.5,
      reasoning: 'r',
    }));
    const text = JSON.stringify({ proposals: items });
    expect(() => parseEdgeProposeOutput(text)).toThrow();
  });

  it('throws on garbage', () => {
    expect(() => parseEdgeProposeOutput('完全不是 JSON')).toThrow();
  });
});

describe('runEdgeProposeAndWrite', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function insertKnowledge(id: string) {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id,
      name: id,
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }

  function emptyAttempts(): FailureAttempt[] {
    return [];
  }

  it('writes ProposeKnowledgeEdge events for each valid proposal', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');
    await insertKnowledge('k3');

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: 'k1 must precede k2',
          },
          {
            from_knowledge_id: 'k2',
            to_knowledge_id: 'k3',
            relation_type: 'related_to',
            weight: 0.4,
            reasoning: 'mild link',
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(2);

    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(events).toHaveLength(2);
    expect(events[0].actor_kind).toBe('agent');
    expect(events[0].actor_ref).toBe('dreaming');
  });

  it('skips self-loops (from === to)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k1',
            relation_type: 'related_to',
            weight: 0.5,
            reasoning: 'self',
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(0);
    expect(stats.skipped_self_loop).toBe(1);
  });

  it('skips unknown nodes (endpoint not in tree)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k_does_not_exist',
            relation_type: 'related_to',
            weight: 0.5,
            reasoning: 'r',
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(0);
    expect(stats.skipped_unknown_node).toBe(1);
  });

  it('skips duplicates of existing knowledge_edge rows (same from/to/type)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');
    await db.insert(knowledge_edge).values({
      id: 'e1',
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'related_to',
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: new Date(),
    });
    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.5,
            reasoning: 'r',
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(0);
    expect(stats.skipped_duplicate_edge).toBe(1);
  });

  it('skips duplicates of pending edge propose events (avoid nightly spam)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');

    // Seed an existing pending proposal
    await db.insert(event).values({
      id: 'e_prev',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'syn_1',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'prerequisite',
        weight: 0.5,
        reasoning: 'prev',
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'prerequisite',
            weight: 0.6,
            reasoning: 'r',
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(0);
    expect(stats.skipped_duplicate_pending).toBe(1);
  });

  it('does not skip when the prior proposal was dismissed (user said no, give it another shot via fresh signals)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');

    // Prior dismissed proposal: propose event + chained rate=dismiss event
    await db.insert(event).values({
      id: 'e_prev',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'syn_1',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'prerequisite',
        weight: 0.5,
        reasoning: 'prev',
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });
    await db.insert(event).values({
      id: 'e_rate',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'knowledge_edge',
      subject_id: 'e_prev',
      outcome: 'success',
      payload: { rating: 'dismiss' },
      caused_by_event_id: 'e_prev',
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 60_000),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'prerequisite',
            weight: 0.8,
            reasoning: 'new evidence',
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(1);
  });

  it('swallows runTask error (no inserts; no throw)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    const fakeRunTask = async () => {
      throw new Error('LLM down');
    };
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(0);

    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(events).toHaveLength(0);
    const ledgerRows = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'KnowledgeEdgeProposeTask'));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].outcome).toBe('failed_retryable');
  });

  it('swallows parse error (no inserts; no throw)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    const fakeRunTask = async () => ({ text: '不是 JSON' });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(0);
  });

  it('returns empty stats when tree is empty (no LLM call)', async () => {
    const db = testDb();
    let called = false;
    const fakeRunTask = async () => {
      called = true;
      return { text: '{"proposals":[]}' };
    };
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(called).toBe(false);
    expect(stats.proposed).toBe(0);
  });

  // P5.4 / YUK-143 (RB-7) — a rubric-rejected (folded) propose event must NOT
  // poison the nightly batch dedup set. Before the fix, loadPendingEdgeProposalKeys
  // added the folded edge's key (no chained rate) → the next batch hit
  // skipped_duplicate_pending and permanently locked out the edge. This is the
  // 4th "pending propose with no rate" query RB-7 requires the marker filtered
  // from. Mirrors the DomainTool / legacy-MCP RB-7 regression tests.
  it('RB-7: a rubric-rejected fold on K does NOT block a later batch re-propose of K', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');

    // Fold a rubric-rejected edge proposal on K = (k1 -> k2, related_to):
    // the propose event is written (folded) carrying a rubric_verdict marker
    // (sibling of ai_proposal), with NO chained rate — exactly the shape the
    // DomainTool/legacy fold via writeAiProposal(event_override) produces.
    await db.insert(event).values({
      id: 'e_folded',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'syn_folded',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'related_to',
        weight: 0.5,
        reasoning: 'evidence-free agent edge → rubric rejected',
        rubric_verdict: { ok: false, gate: 'evidence_missing', reason: 'no evidence' },
        ai_proposal: {
          kind: 'knowledge_edge',
          target: { subject_kind: 'knowledge_edge', subject_id: null },
          reason_md: 'evidence-free agent edge → rubric rejected',
          evidence_refs: [],
          proposed_change: {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.5,
          },
        },
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    // A subsequent batch re-proposing the SAME edge must NOT be deduped against
    // the folded event — it can propose again.
    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: 'fresh attempt with real evidence',
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.skipped_duplicate_pending).toBe(0);
    expect(stats.proposed).toBe(1);
  });

  it('dedupes within a single batch (LLM emits the same edge twice)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');
    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.5,
            reasoning: 'r1',
          },
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: 'r2',
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures: emptyAttempts(),
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(1);
    expect(stats.skipped_duplicate_pending).toBe(1);
  });
});
