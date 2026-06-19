// Phase 2 Dreaming — knowledge_edge nightly propose tests.

import { tasks } from '@/ai/registry';
import { RUBRIC_EVIDENCE_WINDOW_DAYS } from '@/capabilities/knowledge/server/rubric-validator';
import {
  cost_ledger,
  edge_reconciliation_log,
  event,
  knowledge,
  knowledge_edge,
  question,
} from '@/db/schema';
import { RECENT_FAILURE_WINDOW_MS } from '@/server/ai/tools/knowledge-readers';
import { getCorrectionStatus } from '@/server/events/corrections';
import { type FailureAttempt, getFailureAttempts, writeEvent } from '@/server/events/queries';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { EdgeReconcileDecision } from './edge-reconcile';
import { ReconcileParseError } from './edge-reconcile';
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

  // P5.4 §5-Q5 / YUK-175 — the batch path now runs the L1 rubric floor, so a
  // proposal needs strong, endpoint-touching, in-window judge-backed evidence to
  // be written LIVE (otherwise it folds). These helpers seed exactly that so the
  // dedup-mechanics tests below still exercise the pending/duplicate logic on a
  // proposal that PASSES the floor. Mirrors rubric-validator.test.ts seedEvidence.
  async function seedJudgeFailureFor(
    attemptId: string,
    knowledgeIds: string[],
    ageDays: number,
    causeCategory = 'concept',
  ): Promise<void> {
    const db = testDb();
    const questionId = `q_${attemptId}`;
    const createdAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    await db.insert(question).values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: 'r',
      knowledge_ids: knowledgeIds,
      source: 'manual',
      difficulty: 3,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await writeEvent(db, {
      id: attemptId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: knowledgeIds,
      },
      created_at: createdAt,
    });
    await writeEvent(db, {
      id: `judge_${attemptId}`,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: causeCategory,
          secondary_categories: [],
          analysis_md: '用户混淆两个用法。',
          confidence: 0.9,
        },
        referenced_knowledge_ids: knowledgeIds,
      },
      caused_by_event_id: attemptId,
      created_at: new Date(createdAt.getTime() + 500),
    });
  }

  // Strong evidence for an edge touching `endpointIds`: 2 same-cause in-window
  // judge-backed failures referencing an endpoint. `concreteReasoning` builds a
  // reason_md that names a concrete signal (passes the G7a reasoning-depth gate).
  function concreteReasoning(attemptId: string): string {
    return `attempt ${attemptId} 显示用户反复失败，judge cause 为 concept。`;
  }

  it('writes ProposeKnowledgeEdge events for each valid proposal', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');
    await insertKnowledge('k3');
    // Strong, endpoint-touching evidence so both edges pass the L1 floor: two
    // same-cause in-window judge-backed failures referencing k1+k2 (edge1) and
    // k2+k3 (edge2). Same overlap on k2 → strong; touches every endpoint.
    await seedJudgeFailureFor('att_w1', ['k1', 'k2', 'k3'], 1, 'concept');
    await seedJudgeFailureFor('att_w2', ['k1', 'k2', 'k3'], 2, 'concept');
    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: concreteReasoning('att_w1'),
          },
          {
            from_knowledge_id: 'k2',
            to_knowledge_id: 'k3',
            relation_type: 'related_to',
            weight: 0.4,
            reasoning: concreteReasoning('att_w2'),
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
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
    // Strong endpoint-touching evidence so the re-proposed prerequisite passes
    // the L1 floor (otherwise it would fold, not write live).
    await seedJudgeFailureFor('att_d1', ['k1', 'k2'], 1, 'concept');
    await seedJudgeFailureFor('att_d2', ['k1', 'k2'], 2, 'concept');

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

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'prerequisite',
            weight: 0.8,
            reasoning: concreteReasoning('att_d1'),
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
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
    // Strong endpoint-touching evidence so the re-propose passes the L1 floor and
    // is written LIVE — this test proves the folded event does not POISON the
    // dedup set (RB-7); the floor-still-folds case is covered by no-recreate-fold.
    await seedJudgeFailureFor('att_rb7_1', ['k1', 'k2'], 1, 'concept');
    await seedJudgeFailureFor('att_rb7_2', ['k1', 'k2'], 2, 'concept');

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
    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: concreteReasoning('att_rb7_1'),
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
    });
    expect(stats.skipped_duplicate_pending).toBe(0);
    expect(stats.proposed).toBe(1);
  });

  it('dedupes within a single batch (LLM emits the same edge twice)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');
    // Strong endpoint-touching evidence so the FIRST emission passes the L1 floor
    // and is written live; the second emission of the same edge dedups.
    await seedJudgeFailureFor('att_dup_1', ['k1', 'k2'], 1, 'concept');
    await seedJudgeFailureFor('att_dup_2', ['k1', 'k2'], 2, 'concept');
    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.5,
            reasoning: concreteReasoning('att_dup_1'),
          },
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: concreteReasoning('att_dup_2'),
          },
        ],
      }),
    });
    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
    });
    expect(stats.proposed).toBe(1);
    expect(stats.skipped_duplicate_pending).toBe(1);
  });
});

// P5.4 §5-Q5 / YUK-175 — the nightly batch edge-proposer now runs the L1 rubric
// floor (validateProposalQuality) before each live write. A proposal that fails
// the floor is FOLDED (a rubric-rejected propose event written, no live pending
// proposal), exactly like the DomainTool / legacy-MCP agent paths.
describe('runEdgeProposeAndWrite — L1 rubric floor (YUK-175)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    await resetDb();
  });

  async function insertKnowledge(
    id: string,
    domain: string | null = 'wenyan',
    parentId: string | null = null,
  ) {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id,
      name: id,
      domain,
      parent_id: parentId,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }

  // Seed a recent in-window judge-backed failure referencing `knowledgeIds`,
  // mirroring rubric-validator.test.ts seedEvidence. Returns the attempt id.
  async function seedJudgeFailure(
    attemptId: string,
    knowledgeIds: string[],
    ageDays = 1,
    causeCategory = 'concept',
  ): Promise<string> {
    const db = testDb();
    const questionId = `q_${attemptId}`;
    const createdAt = new Date(Date.now() - ageDays * DAY_MS);
    await db.insert(question).values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: 'r',
      knowledge_ids: knowledgeIds,
      source: 'manual',
      difficulty: 3,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await writeEvent(db, {
      id: attemptId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: knowledgeIds,
      },
      created_at: createdAt,
    });
    await writeEvent(db, {
      id: `judge_${attemptId}`,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: causeCategory,
          secondary_categories: [],
          analysis_md: '用户混淆两个用法。',
          confidence: 0.9,
        },
        referenced_knowledge_ids: knowledgeIds,
      },
      caused_by_event_id: attemptId,
      created_at: new Date(createdAt.getTime() + 500),
    });
    return attemptId;
  }

  function reasoningFor(attemptId: string): string {
    return `attempt ${attemptId} 显示用户反复失败，judge cause 为 concept。`;
  }

  it('fold: an edge whose endpoints no recent failure references is folded (rubric reject), no live pending', async () => {
    const db = testDb();
    // Edge endpoints k1/k2. Recent failure references an UNRELATED node k_other,
    // so no in-window judge-backed failure touches an endpoint → §4.3 floor reject.
    await insertKnowledge('k1');
    await insertKnowledge('k2');
    await insertKnowledge('k_other');
    await seedJudgeFailure('att_unrelated', ['k_other'], 1);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });
    expect(recentFailures.length).toBe(1);

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.5,
            reasoning: reasoningFor('att_unrelated'),
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    expect(stats.folded_rubric_rejected).toBe(1);
    expect(stats.proposed).toBe(0);

    // One propose event written, MARKED rubric-rejected (rubric_verdict.ok=false).
    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(1);
    const payload = proposeEvents[0].payload as {
      rubric_verdict?: { ok?: boolean };
      ai_proposal?: unknown;
    };
    expect(payload.rubric_verdict?.ok).toBe(false);
    // The folded event still carries the ai_proposal sibling for audit.
    expect(payload.ai_proposal).toBeTruthy();
  });

  it('pass: an edge with ≥2 same-pattern in-window judge-backed failures touching an endpoint writes a live proposal', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');
    // Two same-cause (concept) in-window judge-backed failures both referencing
    // endpoint k1 → strong evidence + endpoint-touching → related_to floor passes.
    await seedJudgeFailure('att_pass_1', ['k1'], 1, 'concept');
    await seedJudgeFailure('att_pass_2', ['k1'], 2, 'concept');

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });
    expect(recentFailures.length).toBe(2);

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: reasoningFor('att_pass_1'),
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    expect(stats.proposed).toBe(1);
    expect(stats.folded_rubric_rejected).toBe(0);

    // The live propose event is NOT rubric-rejected.
    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(1);
    const payload = proposeEvents[0].payload as { rubric_verdict?: unknown };
    expect(payload.rubric_verdict).toBeUndefined();
  });

  // RB-7 止血证明 (core): a previously-folded edge K must NOT block a later batch
  // from re-proposing K. The folded event is excluded from the live-pending dedup
  // set, AND when the evidence still fails the floor, the batch RE-FOLDS K rather
  // than writing a live pending proposal (validator stops the rebuild).
  it('no-recreate-fold: a prior folded edge K is re-folded (not deduped, not made live) when evidence still fails', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');
    await insertKnowledge('k_other');
    // Recent failure touches only k_other — endpoints of K = (k1,k2) untouched.
    await seedJudgeFailure('att_still_unrelated', ['k_other'], 1);

    // Pre-existing folded event for K (rubric_verdict.ok=false, NO chained rate).
    await db.insert(event).values({
      id: 'e_folded_prior',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'syn_prior_fold',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'related_to',
        weight: 0.5,
        reasoning: 'prior evidence-free agent edge → rubric rejected',
        rubric_verdict: {
          ok: false,
          gate: 'related_to_dumping_ground',
          reason: 'no endpoint evidence',
        },
        ai_proposal: {
          kind: 'knowledge_edge',
          target: { subject_kind: 'knowledge_edge', subject_id: null },
          reason_md: 'prior evidence-free agent edge → rubric rejected',
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
      created_at: new Date(Date.now() - DAY_MS),
    });

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'k1',
            to_knowledge_id: 'k2',
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: reasoningFor('att_still_unrelated'),
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    // Not deduped against the prior fold (RB-7) AND not made live (validator).
    expect(stats.skipped_duplicate_pending).toBe(0);
    expect(stats.proposed).toBe(0);
    expect(stats.folded_rubric_rejected).toBe(1);

    // Now TWO folded propose events for K; ZERO live (non-rubric-rejected) ones.
    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(2);
    const liveEvents = proposeEvents.filter((row) => {
      const p = row.payload as { rubric_verdict?: { ok?: boolean } };
      return p.rubric_verdict?.ok !== false;
    });
    expect(liveEvents).toHaveLength(0);
  });

  // codex r? P2 (propose_edge.ts:163) — per-edge evidence scoping. Before the
  // fix, runEdgeProposeAndWrite attached EVERY recentFailure to EVERY edge's
  // evidence_refs, so edge B (only 1 endpoint-touching failure) could BORROW
  // edge A's 2 same-pattern failures from the SAME batch and clear the strong
  // floor → wrongly written live. After the fix, each edge's evidence_refs is
  // scoped to recentFailures whose effective referenced ids (attempt ∪ judge,
  // matching rubric-validator's effectiveReferencedKnowledgeIds) touch THAT
  // edge's own endpoints. So edge B is scoped to its single failure → medium →
  // folded; edge A keeps its 2 → strong → live.
  it('per-edge evidence scope: edge B cannot borrow edge A batch evidence to clear the strong floor', async () => {
    const db = testDb();
    await insertKnowledge('kA1');
    await insertKnowledge('kA2');
    await insertKnowledge('kB1');
    await insertKnowledge('kB2');

    // Edge A endpoints: kA1/kA2 — TWO same-cause in-window judge-backed failures
    // touch kA1 (strong, endpoint-touching).
    await seedJudgeFailure('att_A1', ['kA1'], 1, 'concept');
    await seedJudgeFailure('att_A2', ['kA1'], 2, 'concept');
    // Edge B endpoints: kB1/kB2 — ONLY ONE in-window judge-backed failure touches
    // kB1 (at most medium on its own).
    await seedJudgeFailure('att_B1', ['kB1'], 1, 'concept');

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });
    expect(recentFailures.length).toBe(3);

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kA1',
            to_knowledge_id: 'kA2',
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: reasoningFor('att_A1'),
          },
          {
            from_knowledge_id: 'kB1',
            to_knowledge_id: 'kB2',
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: reasoningFor('att_B1'),
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    // Edge A: 2 endpoint-touching same-pattern failures → live.
    // Edge B: only 1 endpoint-touching failure (cannot borrow A's) → folded.
    expect(stats.proposed).toBe(1);
    expect(stats.folded_rubric_rejected).toBe(1);

    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(2);

    const edgeA = proposeEvents.find((row) => {
      const p = row.payload as { from_knowledge_id?: string };
      return p.from_knowledge_id === 'kA1';
    });
    const edgeB = proposeEvents.find((row) => {
      const p = row.payload as { from_knowledge_id?: string };
      return p.from_knowledge_id === 'kB1';
    });
    // Edge A written LIVE (no rubric_verdict marker).
    const edgeAPayload = edgeA?.payload as { rubric_verdict?: unknown };
    expect(edgeAPayload.rubric_verdict).toBeUndefined();
    // Edge B written FOLDED (rubric_verdict.ok === false), NOT live pending.
    const edgeBPayload = edgeB?.payload as { rubric_verdict?: { ok?: boolean } };
    expect(edgeBPayload.rubric_verdict?.ok).toBe(false);
  });

  it('window-merge: knowledge-readers recent-failure window is sourced from RUBRIC_EVIDENCE_WINDOW_DAYS (no hardcoded 30)', () => {
    expect(RECENT_FAILURE_WINDOW_MS).toBe(RUBRIC_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });
});

// ADR-0034 §2 / YUK-344 — write-time structural consistency gate (topology layer)
// WIRED into runEdgeProposeAndWrite. These exercise the gate's integration with
// the propose path (the pure logic itself is unit-tested in
// topology-gate.unit.test.ts); here we confirm a cycle/direction reject FOLDS
// (marked topology_verdict, no live pending) and a transitive-redundancy WARN
// still writes live with a marker.
describe('runEdgeProposeAndWrite — topology gate (ADR-0034 §2 / YUK-344)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

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

  async function insertLiveEdge(
    id: string,
    from: string,
    to: string,
    relation = 'prerequisite',
    archivedAt: Date | null = null,
  ) {
    const db = testDb();
    await db.insert(knowledge_edge).values({
      id,
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: relation,
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: new Date(),
      archived_at: archivedAt,
    });
  }

  // Seed a recent in-window judge-backed failure referencing both endpoints so
  // the rubric floor would otherwise PASS — proving the FOLD is the topology
  // gate's doing, not the rubric gate's.
  async function seedJudgeFailure(attemptId: string, knowledgeIds: string[]): Promise<void> {
    const db = testDb();
    const questionId = `q_${attemptId}`;
    const createdAt = new Date(Date.now() - DAY_MS);
    await db.insert(question).values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: 'r',
      knowledge_ids: knowledgeIds,
      source: 'manual',
      difficulty: 3,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await writeEvent(db, {
      id: attemptId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: knowledgeIds,
      },
      created_at: createdAt,
    });
    await writeEvent(db, {
      id: `judge_${attemptId}`,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'concept',
          secondary_categories: [],
          analysis_md: '用户混淆两个用法。',
          confidence: 0.9,
        },
        referenced_knowledge_ids: knowledgeIds,
      },
      caused_by_event_id: attemptId,
      created_at: new Date(createdAt.getTime() + 500),
    });
  }

  it('folds a prerequisite edge that closes a cycle (A→B→C live, propose C→A)', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    await insertLiveEdge('e_ab', 'kA', 'kB');
    await insertLiveEdge('e_bc', 'kB', 'kC');
    // Two strong same-pattern failures touching the endpoints so the rubric gate
    // would pass on its own — isolating the topology fold.
    await seedJudgeFailure('att_1', ['kC', 'kA']);
    await seedJudgeFailure('att_2', ['kC', 'kA']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kC',
            to_knowledge_id: 'kA',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: 'attempt att_1 显示 kC 与 kA 的 prerequisite 顺序。',
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    expect(stats.folded_topology_rejected).toBe(1);
    expect(stats.proposed).toBe(0);
    expect(stats.folded_rubric_rejected).toBe(0);

    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(1);
    const payload = proposeEvents[0].payload as {
      topology_verdict?: { status?: string; gate?: string };
    };
    expect(payload.topology_verdict?.status).toBe('reject');
    expect(payload.topology_verdict?.gate).toBe('cycle');
  });

  it('folds a direction-contradiction prerequisite (A→B live, propose B→A)', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertLiveEdge('e_ab', 'kA', 'kB');
    await seedJudgeFailure('att_1', ['kA', 'kB']);
    await seedJudgeFailure('att_2', ['kA', 'kB']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kB',
            to_knowledge_id: 'kA',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: 'attempt att_1 显示顺序。',
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    expect(stats.folded_topology_rejected).toBe(1);
    expect(stats.proposed).toBe(0);

    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    const payload = proposeEvents[0].payload as { topology_verdict?: { gate?: string } };
    expect(payload.topology_verdict?.gate).toBe('direction_contradiction');
  });

  it('warns (not rejects) a transitively-redundant direct edge — written live with marker', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    await insertLiveEdge('e_ab', 'kA', 'kB');
    await insertLiveEdge('e_bc', 'kB', 'kC');
    await seedJudgeFailure('att_1', ['kA', 'kC']);
    await seedJudgeFailure('att_2', ['kA', 'kC']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kA',
            to_knowledge_id: 'kC',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: 'attempt att_1 显示 kA→kC 的 prerequisite 顺序。',
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    expect(stats.warned_transitive_redundancy).toBe(1);
    expect(stats.proposed).toBe(1);
    expect(stats.folded_topology_rejected).toBe(0);

    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(1);
    const payload = proposeEvents[0].payload as {
      topology_verdict?: { status?: string; gate?: string };
    };
    expect(payload.topology_verdict?.status).toBe('warn');
    expect(payload.topology_verdict?.gate).toBe('transitive_redundancy');
  });

  it('ignores ARCHIVED edges — an archived A→B does not contradict a live B→A', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    // A→B exists but is ARCHIVED, so it is not part of the live graph; B→A must
    // NOT be folded as a direction contradiction.
    await insertLiveEdge('e_ab', 'kA', 'kB', 'prerequisite', new Date());
    await seedJudgeFailure('att_1', ['kA', 'kB']);
    await seedJudgeFailure('att_2', ['kA', 'kB']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kB',
            to_knowledge_id: 'kA',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: 'attempt att_1 显示 kB→kA 顺序。',
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    expect(stats.folded_topology_rejected).toBe(0);
    expect(stats.proposed).toBe(1);
  });

  // ADR-0034 §2 / YUK-344 (RB-7 twin for the TOPOLOGY marker) — a previously
  // topology-rejected (folded) propose event must NOT block a later batch from
  // re-proposing the same edge. The fold carries a `topology_verdict.status =
  // 'reject'` marker and NO rubric_verdict key, so the cross-batch dedup
  // (loadPendingEdgeProposalKeys) MUST filter it out — otherwise it would be
  // counted live-pending and the next batch hits `skipped_duplicate_pending`,
  // permanently refusing to re-propose the very edge topology rejected. The
  // edge still closes a cycle on the live graph, so the re-propose RE-FOLDS
  // (proving it was re-evaluated, not deduped away).
  it('RB-7 (topology): a topology-rejected fold on K does NOT block a later batch re-propose of K', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    // Live prerequisite chain kA→kB→kC: proposing kC→kA closes a cycle.
    await insertLiveEdge('e_ab', 'kA', 'kB');
    await insertLiveEdge('e_bc', 'kB', 'kC');
    // Strong endpoint-touching failures so the rubric floor would PASS — isolating
    // the topology fold (and matching the rest of this describe block).
    await seedJudgeFailure('att_1', ['kC', 'kA']);
    await seedJudgeFailure('att_2', ['kC', 'kA']);

    // Pre-existing TOPOLOGY-folded event for K = (kC→kA, prerequisite): a
    // `topology_verdict.status = 'reject'` marker, NO rubric_verdict key, NO
    // chained rate (so without the dedup filter it would look live-pending).
    await db.insert(event).values({
      id: 'e_topo_folded_prior',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge_edge',
      subject_id: 'syn_prior_topo_fold',
      outcome: 'success',
      payload: {
        from_knowledge_id: 'kC',
        to_knowledge_id: 'kA',
        relation_type: 'prerequisite',
        weight: 0.5,
        reasoning: 'prior cycle-closing edge → topology rejected',
        topology_verdict: { status: 'reject', gate: 'cycle', reason: 'closes a cycle' },
        ai_proposal: {
          kind: 'knowledge_edge',
          target: { subject_kind: 'knowledge_edge', subject_id: null },
          reason_md: 'prior cycle-closing edge → topology rejected',
          evidence_refs: [],
          proposed_change: {
            from_knowledge_id: 'kC',
            to_knowledge_id: 'kA',
            relation_type: 'prerequisite',
            weight: 0.5,
          },
          cooldown_key: 'knowledge_edge:kC|kA|prerequisite',
        },
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(Date.now() - DAY_MS),
    });

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kC',
            to_knowledge_id: 'kA',
            relation_type: 'prerequisite',
            weight: 0.6,
            reasoning: 'attempt att_1 显示 kC 与 kA 的 prerequisite 顺序。',
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    // NOT deduped against the prior topology fold (the RB-7 twin fix) AND the
    // edge is re-evaluated → re-folded (still closes a cycle on the live graph).
    expect(stats.skipped_duplicate_pending).toBe(0);
    expect(stats.proposed).toBe(0);
    expect(stats.folded_topology_rejected).toBe(1);

    // Now TWO topology-folded propose events for K; ZERO live ones (no folded
    // event leaks into the live pool).
    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(2);
    const liveEvents = proposeEvents.filter((row) => {
      const p = row.payload as { topology_verdict?: { status?: string } };
      return p.topology_verdict?.status !== 'reject';
    });
    expect(liveEvents).toHaveLength(0);
  });

  // FINDING A (YUK-344) — intra-batch accumulator correctness. A proposal folded
  // earlier in the SAME batch (here by the RUBRIC gate) is intentionally NOT
  // pushed into `liveTopologyEdges`, because a folded edge is never persisted
  // live. So a LATER same-batch edge that would ONLY close a cycle THROUGH that
  // folded edge must be ALLOWED (the cycle does not exist in the live graph).
  // This documents the intentional exclusion: adding folded edges to the
  // accumulator would cause false topology rejections.
  it('does NOT topology-reject a later batch edge whose only cycle path runs through an EARLIER rubric-folded edge', async () => {
    const db = testDb();
    await insertKnowledge('kX');
    await insertKnowledge('kY');
    await insertKnowledge('kZ');
    // Live prerequisite edge kY→kZ. If a live kZ→kX existed too, then kY would
    // reach kX (kY→kZ→kX) and a later kX→kY would close the cycle kX→kY→kZ→kX.
    await insertLiveEdge('e_yz', 'kY', 'kZ');
    // Evidence touches ONLY kY (proposal 2's endpoint), with two same-cause
    // in-window judge-backed failures → proposal 2 (kX→kY) passes the rubric
    // floor. It does NOT touch kZ or kX, so proposal 1 (kZ→kX) has no
    // endpoint-touching evidence and the rubric gate FOLDS it.
    await seedJudgeFailure('att_finding_a_1', ['kY']);
    await seedJudgeFailure('att_finding_a_2', ['kY']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          // Proposal 1 — kZ→kX. No endpoint-touching evidence → RUBRIC-folded.
          // If (wrongly) added to the live accumulator, it would let proposal 2
          // close a cycle.
          {
            from_knowledge_id: 'kZ',
            to_knowledge_id: 'kX',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: 'kZ→kX 顺序（无端点证据，应被 rubric 折叠）。',
          },
          // Proposal 2 — kX→kY. Only closes a cycle THROUGH the folded kZ→kX, so
          // on the LIVE graph (kY→kZ only) it forms no cycle → must be allowed.
          {
            from_knowledge_id: 'kX',
            to_knowledge_id: 'kY',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: 'attempt att_finding_a_1 显示 kX→kY 的 prerequisite 顺序。',
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({ db, recentFailures, runTaskFn: fakeRunTask });
    // Proposal 1 rubric-folded; proposal 2 written live and NOT topology-rejected.
    expect(stats.folded_rubric_rejected).toBe(1);
    expect(stats.folded_topology_rejected).toBe(0);
    expect(stats.proposed).toBe(1);

    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(2);
    // The kX→kY proposal is LIVE: no topology_verdict marker at all.
    const edge2 = proposeEvents.find((row) => {
      const p = row.payload as { from_knowledge_id?: string };
      return p.from_knowledge_id === 'kX';
    });
    const edge2Payload = edge2?.payload as { topology_verdict?: unknown };
    expect(edge2Payload?.topology_verdict).toBeUndefined();
  });
});

// ADR-0034 §3 / YUK-344 增量 2 — write-time RECONCILIATION RING wired into
// runEdgeProposeAndWrite. The pure decision layer (judgeEdgeReconcile / parse /
// confidence threshold) is unit-tested in edge-reconcile.unit.test.ts; here we
// confirm the WIRING: topology runs first and short-circuits (reconcile never
// sees a topology-rejected edge), a SUPERSEDE archives the old edge + writes the
// log row + emits a CorrectionKind correction event + writes the new live edge, a
// KEEP_BOTH proceeds as a pending proposal unchanged, and parse-error /
// low-confidence safe-degrade to KEEP_BOTH. The judge is INJECTED (judgeReconcileFn)
// so no live GLM call is made.
describe('runEdgeProposeAndWrite — reconciliation ring (ADR-0034 §3 / YUK-344)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

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

  async function insertLiveEdge(
    id: string,
    from: string,
    to: string,
    relation = 'contrasts_with',
    archivedAt: Date | null = null,
  ) {
    const db = testDb();
    await db.insert(knowledge_edge).values({
      id,
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: relation,
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: new Date(),
      archived_at: archivedAt,
    });
  }

  // Strong endpoint-touching evidence so the candidate passes the rubric floor —
  // isolating the reconcile branch as the only thing diverging from the baseline.
  async function seedJudgeFailure(attemptId: string, knowledgeIds: string[]): Promise<void> {
    const db = testDb();
    const questionId = `q_${attemptId}`;
    const createdAt = new Date(Date.now() - DAY_MS);
    await db.insert(question).values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: 'r',
      knowledge_ids: knowledgeIds,
      source: 'manual',
      difficulty: 3,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await writeEvent(db, {
      id: attemptId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: knowledgeIds,
      },
      created_at: createdAt,
    });
    await writeEvent(db, {
      id: `judge_${attemptId}`,
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'concept',
          secondary_categories: [],
          analysis_md: '用户混淆两个用法。',
          confidence: 0.9,
        },
        referenced_knowledge_ids: knowledgeIds,
      },
      caused_by_event_id: attemptId,
      created_at: new Date(createdAt.getTime() + 500),
    });
  }

  function reasoningFor(attemptId: string): string {
    return `attempt ${attemptId} 显示用户反复失败，judge cause 为 concept。`;
  }

  // Inject a judge that SUPERSEDES the first neighbor it is handed.
  const supersedeFirstNeighbor = async (
    _cand: unknown,
    neighbors: Array<{ index: number; edge_id: string }>,
  ): Promise<EdgeReconcileDecision> => ({
    action: 'SUPERSEDE',
    neighbor_index: neighbors[0].index,
    superseded_edge_id: neighbors[0].edge_id,
    confidence: 0.9,
    reason: 'candidate semantically corrects the live neighbor',
  });

  it('SUPERSEDE: archives the old edge + writes the log row + emits the correction event + writes the new edge', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    // CodeRabbit/Bugbot Finding 1 regression lock: the OLD/neighbor edge endpoints
    // must DIFFER from the candidate on every axis the archive payload records
    // (from, to, AND relation_type) so a step-4 archive event that wrongly used the
    // CANDIDATE endpoints would be DETECTABLY wrong. Old edge = kB --related_to--> kA
    // (shares endpoint kA, but from/to are reversed AND a different relation_type vs
    // the candidate kA --contrasts_with--> kC). The reconcile neighbor filter only
    // requires sharing ONE endpoint, so this is a valid neighbor.
    await insertLiveEdge('e_old', 'kB', 'kA', 'related_to');
    await seedJudgeFailure('att_sup_1', ['kA', 'kC']);
    await seedJudgeFailure('att_sup_2', ['kA', 'kC']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kA',
            to_knowledge_id: 'kC',
            relation_type: 'contrasts_with',
            weight: 0.7,
            reasoning: reasoningFor('att_sup_1'),
          },
        ],
      }),
    });

    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
      judgeReconcileFn: supersedeFirstNeighbor,
    });
    expect(stats.reconcile_superseded).toBe(1);
    // No live PENDING proposal was written for a superseded candidate.
    expect(stats.proposed).toBe(0);

    // Old edge soft-archived (the load-bearing removal).
    const oldEdge = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'e_old'))
      .limit(1);
    expect(oldEdge[0].archived_at).not.toBeNull();

    // A new LIVE edge kA --contrasts_with--> kC exists (not archived).
    const liveEdges = await db
      .select()
      .from(knowledge_edge)
      .where(and(eq(knowledge_edge.from_knowledge_id, 'kA'), isNull(knowledge_edge.archived_at)));
    expect(liveEdges).toHaveLength(1);
    expect(liveEdges[0].to_knowledge_id).toBe('kC');
    expect(liveEdges[0].relation_type).toBe('contrasts_with');

    // Finding 1 regression lock: the step-4 OLD-edge archive-provenance event must
    // describe the SUPERSEDED OLD edge endpoints (kB --related_to--> kA), NOT the
    // candidate's (kA --contrasts_with--> kC). It is the `generate` event anchored
    // to the superseded edge id (e_old) carrying an `edge_op: 'archive'` marker.
    const archiveEvents = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'generate'),
          eq(event.subject_kind, 'knowledge_edge'),
          eq(event.subject_id, 'e_old'),
        ),
      );
    expect(archiveEvents).toHaveLength(1);
    const archivePayload = archiveEvents[0].payload as {
      edge_op?: string;
      archive_edge_id?: string;
      from_knowledge_id?: string;
      to_knowledge_id?: string;
      relation_type?: string;
    };
    expect(archivePayload.edge_op).toBe('archive');
    expect(archivePayload.archive_edge_id).toBe('e_old');
    // EQUAL the OLD edge endpoints…
    expect(archivePayload.from_knowledge_id).toBe('kB');
    expect(archivePayload.to_knowledge_id).toBe('kA');
    expect(archivePayload.relation_type).toBe('related_to');
    // …and NOT the candidate's endpoints (the exact misdescription Finding 1 fixes).
    expect(archivePayload.from_knowledge_id).not.toBe('kA');
    expect(archivePayload.to_knowledge_id).not.toBe('kC');
    expect(archivePayload.relation_type).not.toBe('contrasts_with');

    // Audit-log row written AND applied within the single tx (applied_at set;
    // no row left unapplied).
    const logRows = await db.select().from(edge_reconciliation_log);
    expect(logRows).toHaveLength(1);
    expect(logRows[0].action).toBe('SUPERSEDE');
    expect(logRows[0].superseded_edge_id).toBe('e_old');
    expect(logRows[0].applied_at).not.toBeNull();
    const unapplied = await db
      .select()
      .from(edge_reconciliation_log)
      .where(isNull(edge_reconciliation_log.applied_at));
    expect(unapplied).toHaveLength(0);

    // A CorrectionKind supersede correction event was emitted (provenance). It
    // targets the OLD edge's archive-provenance generate event; that event is
    // therefore SUPERSEDED with a replacement pointing at the new edge's
    // generate event.
    const correctRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.subject_kind, 'event')));
    expect(correctRows).toHaveLength(1);
    const correctPayload = correctRows[0].payload as { correction_kind?: string };
    expect(correctPayload.correction_kind).toBe('supersede');
    // YUK-344 attribution: an AUTONOMOUS nightly supersede is attributed to the
    // dreaming AGENT, NOT user/self (it is not a human correction).
    expect(correctRows[0].actor_kind).toBe('agent');
    expect(correctRows[0].actor_ref).toBe('dreaming');

    const status = await getCorrectionStatus(db, correctRows[0].subject_id);
    expect(status.state).toBe('superseded');
    if (status.state === 'superseded') {
      // The replacement is the NEW edge's generate event (a real event row).
      const replacement = await db
        .select()
        .from(event)
        .where(eq(event.id, status.replacement_event_id))
        .limit(1);
      expect(replacement[0].action).toBe('generate');
      expect(replacement[0].subject_kind).toBe('knowledge_edge');
    }
  });

  it('KEEP_BOTH: a no-contradiction candidate proceeds as a pending proposal unchanged (no archive, no new edge, no correction)', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    // Live neighbor kA --contrasts_with--> kB; the judge says KEEP_BOTH.
    await insertLiveEdge('e_keep', 'kA', 'kB', 'contrasts_with');
    await seedJudgeFailure('att_keep_1', ['kA', 'kC']);
    await seedJudgeFailure('att_keep_2', ['kA', 'kC']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kA',
            to_knowledge_id: 'kC',
            relation_type: 'contrasts_with',
            weight: 0.7,
            reasoning: reasoningFor('att_keep_1'),
          },
        ],
      }),
    });

    const keepBoth = async (): Promise<EdgeReconcileDecision> => ({
      action: 'KEEP_BOTH',
      neighbor_index: null,
      superseded_edge_id: null,
      confidence: 0.95,
      reason: 'distinct coexisting contrasts',
    });

    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
      judgeReconcileFn: keepBoth,
    });
    // Behavior-equivalent to today: a live pending PROPOSE event, nothing else.
    expect(stats.proposed).toBe(1);
    expect(stats.reconcile_superseded).toBe(0);

    // Old neighbor edge untouched (still live).
    const oldEdge = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'e_keep'))
      .limit(1);
    expect(oldEdge[0].archived_at).toBeNull();

    // No NEW live edge row was written (KEEP_BOTH only writes a propose event).
    const liveEdges = await db
      .select()
      .from(knowledge_edge)
      .where(isNull(knowledge_edge.archived_at));
    expect(liveEdges).toHaveLength(1); // only e_keep
    // No correction event, no reconcile log row.
    const correctRows = await db.select().from(event).where(eq(event.action, 'correct'));
    expect(correctRows).toHaveLength(0);
    const logRows = await db.select().from(edge_reconciliation_log);
    expect(logRows).toHaveLength(0);
    // A normal pending propose event exists.
    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(proposeEvents).toHaveLength(1);
    const proposePayload = proposeEvents[0].payload as { topology_verdict?: unknown };
    expect(proposePayload.topology_verdict).toBeUndefined();
  });

  it('topology short-circuits BEFORE reconcile: a topology-rejected candidate NEVER reaches the reconcile judge', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    // Live prerequisite kA→kB; candidate kB→kA is a direction contradiction →
    // topology HARD-rejects BEFORE reconcile. The judge must never be called.
    await insertLiveEdge('e_ab', 'kA', 'kB', 'prerequisite');
    await seedJudgeFailure('att_topo_1', ['kA', 'kB']);
    await seedJudgeFailure('att_topo_2', ['kA', 'kB']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kB',
            to_knowledge_id: 'kA',
            relation_type: 'prerequisite',
            weight: 0.7,
            reasoning: reasoningFor('att_topo_1'),
          },
        ],
      }),
    });

    let judgeCalled = false;
    const judgeThatMustNotRun = async (): Promise<EdgeReconcileDecision> => {
      judgeCalled = true;
      throw new Error('reconcile judge must NOT be called for a topology-rejected edge');
    };

    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
      judgeReconcileFn: judgeThatMustNotRun,
    });
    expect(judgeCalled).toBe(false);
    expect(stats.folded_topology_rejected).toBe(1);
    expect(stats.reconcile_superseded).toBe(0);
    // No new edge, no archive, no log row.
    const logRows = await db.select().from(edge_reconciliation_log);
    expect(logRows).toHaveLength(0);
  });

  it('parse-error degrades to KEEP_BOTH (no destructive supersede on an unparseable judge)', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    await insertLiveEdge('e_old', 'kA', 'kB', 'contrasts_with');
    await seedJudgeFailure('att_pe_1', ['kA', 'kC']);
    await seedJudgeFailure('att_pe_2', ['kA', 'kC']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kA',
            to_knowledge_id: 'kC',
            relation_type: 'contrasts_with',
            weight: 0.7,
            reasoning: reasoningFor('att_pe_1'),
          },
        ],
      }),
    });

    const throwingJudge = async (): Promise<EdgeReconcileDecision> => {
      throw new ReconcileParseError('bad json', '{');
    };

    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
      judgeReconcileFn: throwingJudge,
    });
    // Degrades to KEEP_BOTH → a live pending propose, no supersede.
    expect(stats.reconcile_superseded).toBe(0);
    expect(stats.proposed).toBe(1);
    const oldEdge = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'e_old'))
      .limit(1);
    expect(oldEdge[0].archived_at).toBeNull();
    const logRows = await db.select().from(edge_reconciliation_log);
    expect(logRows).toHaveLength(0);
  });

  it('low-confidence SUPERSEDE degrades to KEEP_BOTH (confidence threshold re-applied in the wiring)', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    await insertLiveEdge('e_old', 'kA', 'kB', 'contrasts_with');
    await seedJudgeFailure('att_lc_1', ['kA', 'kC']);
    await seedJudgeFailure('att_lc_2', ['kA', 'kC']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kA',
            to_knowledge_id: 'kC',
            relation_type: 'contrasts_with',
            weight: 0.7,
            reasoning: reasoningFor('att_lc_1'),
          },
        ],
      }),
    });

    // A SUPERSEDE below the 0.6 threshold — the wiring's defensive
    // applyConfidenceThreshold must downgrade it to KEEP_BOTH.
    const lowConfidenceSupersede = async (
      _cand: unknown,
      neighbors: Array<{ index: number; edge_id: string }>,
    ): Promise<EdgeReconcileDecision> => ({
      action: 'SUPERSEDE',
      neighbor_index: neighbors[0].index,
      superseded_edge_id: neighbors[0].edge_id,
      confidence: 0.3,
      reason: 'unsure',
    });

    const stats = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
      judgeReconcileFn: lowConfidenceSupersede,
    });
    expect(stats.reconcile_superseded).toBe(0);
    expect(stats.proposed).toBe(1);
    const oldEdge = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'e_old'))
      .limit(1);
    expect(oldEdge[0].archived_at).toBeNull();
  });

  it('no double-apply: the UNIQUE(from,to,relation_type) constraint makes a re-proposed superseded candidate skipped_duplicate_edge (not a second archive/new edge)', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    await insertLiveEdge('e_old', 'kA', 'kB', 'contrasts_with');
    await seedJudgeFailure('att_idem_1', ['kA', 'kC']);
    await seedJudgeFailure('att_idem_2', ['kA', 'kC']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kA',
            to_knowledge_id: 'kC',
            relation_type: 'contrasts_with',
            weight: 0.7,
            reasoning: reasoningFor('att_idem_1'),
          },
        ],
      }),
    });

    // First run: SUPERSEDE applied (archive old, write new, log applied).
    const first = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
      judgeReconcileFn: supersedeFirstNeighbor,
    });
    expect(first.reconcile_superseded).toBe(1);

    const logAfterFirst = await db.select().from(edge_reconciliation_log);
    expect(logAfterFirst).toHaveLength(1);
    expect(logAfterFirst[0].applied_at).not.toBeNull();
    const liveAfterFirst = await db
      .select()
      .from(knowledge_edge)
      .where(isNull(knowledge_edge.archived_at));
    // Exactly one live edge: the new kA→kC (old kA→kB archived).
    expect(liveAfterFirst).toHaveLength(1);
    expect(liveAfterFirst[0].to_knowledge_id).toBe('kC');

    // The apply ran in a single tx, so the audit-log row is stamped applied_at
    // (no row left unapplied). There is no replay cursor — a crash would have
    // rolled the row back entirely.
    const unapplied = await db
      .select()
      .from(edge_reconciliation_log)
      .where(isNull(edge_reconciliation_log.applied_at));
    expect(unapplied).toHaveLength(0);

    // The real no-double-apply guard: the new candidate edge is now a real live
    // row, so a SUBSEQUENT batch proposing the SAME (from,to,relation_type) edge
    // is `skipped_duplicate_edge` via the UNIQUE constraint BEFORE the apply path
    // (it does not double-archive / double-write).
    const second = await runEdgeProposeAndWrite({
      db,
      recentFailures,
      runTaskFn: fakeRunTask,
      judgeReconcileFn: supersedeFirstNeighbor,
    });
    expect(second.skipped_duplicate_edge).toBe(1);
    expect(second.reconcile_superseded).toBe(0);
    // Still exactly one reconcile log row + one live new edge (no double-apply).
    const logAfterSecond = await db.select().from(edge_reconciliation_log);
    expect(logAfterSecond).toHaveLength(1);
    const liveAfterSecond = await db
      .select()
      .from(knowledge_edge)
      .where(isNull(knowledge_edge.archived_at));
    expect(liveAfterSecond).toHaveLength(1);
  });

  // YUK-344 (Issue 3) — the LIVE judge path (no injected judgeReconcileFn) must
  // ledger its GLM tokens to cost_ledger via the onUsage hook, mirroring the
  // memory reconcile path (triggers.ts / YUK-359). Exercises judgeEdgeReconcile
  // through runEdgeProposeAndWrite with a MOCKED global fetch (the wiring does not
  // thread fetchImpl, so the judge uses global fetch) returning a SUPERSEDE with
  // usage tokens; asserts an `edge_reconcile` cost_ledger row is written AND the
  // supersede actually applied (proving the bill is for a real live judgment).
  it('live judge path writes a cost_ledger row for reconcile GLM usage (YUK-344 Issue 3)', async () => {
    const db = testDb();
    await insertKnowledge('kA');
    await insertKnowledge('kB');
    await insertKnowledge('kC');
    // Live neighbor kA --contrasts_with--> kB; the live GLM judge will SUPERSEDE it
    // in favor of the candidate kA --contrasts_with--> kC.
    await insertLiveEdge('e_old', 'kA', 'kB', 'contrasts_with');
    await seedJudgeFailure('att_cost_1', ['kA', 'kC']);
    await seedJudgeFailure('att_cost_2', ['kA', 'kC']);

    const recentFailures = await getFailureAttempts(db, {
      since: new Date(Date.now() - 5 * DAY_MS),
    });

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: 'kA',
            to_knowledge_id: 'kC',
            relation_type: 'contrasts_with',
            weight: 0.7,
            reasoning: reasoningFor('att_cost_1'),
          },
        ],
      }),
    });

    // Mock global fetch: the live judge resolves GLM config from env then POSTs to
    // {baseURL}/chat/completions. Return a SUPERSEDE of neighbor_index 0 (the only
    // neighbor handed to the ring) WITH usage tokens so onUsage fires.
    const glmResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision: {
                action: 'SUPERSEDE',
                neighbor_index: 0,
                confidence: 0.88,
                reason: 'candidate corrects the live neighbor',
              },
            }),
          },
        },
      ],
      usage: { prompt_tokens: 321, completion_tokens: 42, total_tokens: 363 },
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(glmResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const stats = await runEdgeProposeAndWrite({
        db,
        recentFailures,
        runTaskFn: fakeRunTask,
        // Env carries the ZHIPU/DASHSCOPE keys createMem0Config requires; NO
        // judgeReconcileFn → the LIVE judgeEdgeReconcile runs (against fetchMock).
        // CodeRabbit/PR-Agent Finding 3 regression lock: MEM0_LLM_MODEL overrides
        // the GLM model to a NON-default value, so a cost_ledger row that hardcoded
        // 'glm-5.2' would be DETECTABLY wrong. The model must come from the same
        // resolveGlmConfig(env) the judge uses.
        env: {
          DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
          ZHIPU_API_KEY: 'test-key',
          DASHSCOPE_API_KEY: 'test-dashscope',
          MEM0_LLM_MODEL: 'glm-4.6-test-override',
        },
      });

      // The live judge ran and superseded the neighbor.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(stats.reconcile_superseded).toBe(1);

      // The GLM tokens were ledgered to cost_ledger under task_kind='edge_reconcile'.
      const ledgerRows = await db
        .select()
        .from(cost_ledger)
        .where(eq(cost_ledger.task_kind, 'edge_reconcile'));
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0].provider).toBe('glm');
      expect(ledgerRows[0].currency).toBe('CNY');
      expect(ledgerRows[0].tokens_in).toBe(321);
      expect(ledgerRows[0].tokens_out).toBe(42);
      expect(Number(ledgerRows[0].cost)).toBeGreaterThan(0);
      // Finding 3: the ledger model is the RESOLVED model (MEM0_LLM_MODEL override),
      // NOT the previously-hardcoded 'glm-5.2'.
      expect(ledgerRows[0].model).toBe('glm-4.6-test-override');
      expect(ledgerRows[0].model).not.toBe('glm-5.2');
    } finally {
      global.fetch = originalFetch;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
