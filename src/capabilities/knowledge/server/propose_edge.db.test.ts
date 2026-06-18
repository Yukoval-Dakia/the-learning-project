// Phase 2 Dreaming — knowledge_edge nightly propose tests.

import { tasks } from '@/ai/registry';
import { RUBRIC_EVIDENCE_WINDOW_DAYS } from '@/capabilities/knowledge/server/rubric-validator';
import { cost_ledger, event, knowledge, knowledge_edge, question } from '@/db/schema';
import { RECENT_FAILURE_WINDOW_MS } from '@/server/ai/tools/knowledge-readers';
import { type FailureAttempt, getFailureAttempts, writeEvent } from '@/server/events/queries';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
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
});
