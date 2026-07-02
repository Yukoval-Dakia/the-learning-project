// Phase 1c.1 Step 9.D — proposals.test rewritten for event-based handlers.
//
// Pre-Step-9 tests INSERTed dreaming_proposal rows; post-Step-9 the legacy
// table is gone. Seed propose events directly + assert event-driven flow.

import { KnowledgeRowSnapshot } from '@/core/schema/event/genesis';
import {
  event,
  goal,
  kc_typed_state,
  knowledge,
  knowledge_edge,
  learning_item,
  mastery_state,
  materialized_id_index,
  misconception_edge,
  question,
} from '@/db/schema';
import { gatherAndFoldKnowledgeNode } from '@/server/projections/gather';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  acceptProposal,
  applyArchive,
  applyMerge,
  applyProposeNew,
  applyReparent,
  applySplit,
  dismissProposal,
  writeKnowledgeProposeEvent,
} from './proposals';

// liveSnapshot — project the live `knowledge` row down to the structural
// KnowledgeRowSnapshot subset (drops embed_* columns, coerces timestamps to
// Date) so it deep-equals what gatherAndFoldKnowledgeNode returns. This is the
// exact parity the PR-B double-write phase will assert at accept time.
async function liveSnapshot(id: string) {
  const db = testDb();
  const rows = await db.select().from(knowledge).where(eq(knowledge.id, id));
  if (!rows[0]) return null;
  return KnowledgeRowSnapshot.parse(rows[0]);
}

async function insertKnowledge(opts: {
  id: string;
  name?: string;
  domain?: string | null;
  parent_id?: string | null;
  archived?: boolean;
  version?: number;
  merged_from?: string[];
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id: opts.id,
    name: opts.name ?? opts.id,
    domain: opts.domain !== undefined ? opts.domain : 'wenyan',
    parent_id: opts.parent_id ?? null,
    merged_from: opts.merged_from ?? [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: opts.version ?? 0,
  });
}

async function insertProposeEvent(opts: {
  id: string;
  payload: Record<string, unknown>;
  reasoning?: string;
  action?: string;
  subject_id?: string;
  // rate event chained to this propose to simulate already-decided
  rate?: 'accept' | 'dismiss' | 'rollback';
}) {
  const db = testDb();
  const now = new Date();
  const action =
    opts.action ??
    (opts.payload.mutation === 'propose_new'
      ? 'propose'
      : `experimental:knowledge_${opts.payload.mutation}`);
  const isProposeNew = opts.payload.mutation === 'propose_new';
  // Strip mutation key for event payload (it's encoded in action)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { mutation, ...rest } = opts.payload;
  const eventPayload = isProposeNew
    ? { ...rest, reasoning: opts.reasoning ?? 'r' }
    : { ...rest, reasoning: opts.reasoning ?? 'r' };
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action,
    subject_kind: 'knowledge',
    subject_id: opts.subject_id ?? `subject_${opts.id}`,
    outcome: 'partial',
    payload: eventPayload,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
  if (opts.rate) {
    await db.insert(event).values({
      id: `rate_${opts.id}`,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: opts.id,
      outcome: 'success',
      payload: { rating: opts.rate },
      caused_by_event_id: opts.id,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
  }
}

describe('writeKnowledgeProposeEvent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a propose event with subject_kind=knowledge for propose_new', async () => {
    const db = testDb();
    const id = await writeKnowledgeProposeEvent(db, {
      payload: {
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      },
      reasoning: '看 mistake 涉及通假字',
    });
    expect(id).toMatch(/^[a-z0-9]+$/);
    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows[0]?.action).toBe('propose');
    expect(rows[0]?.subject_kind).toBe('knowledge');
    expect(rows[0]?.outcome).toBe('partial');
    expect((rows[0]?.payload as Record<string, unknown>).name).toBe('通假字');
  });

  it('writes archive proposals through the shared ai_proposal envelope', async () => {
    const db = testDb();
    const id = await writeKnowledgeProposeEvent(db, {
      payload: { mutation: 'archive', node_id: 'k_node', expected_version: 5 },
      reasoning: '过时',
    });
    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows[0]?.action).toBe('experimental:knowledge_archive');
    expect(rows[0]?.subject_kind).toBe('knowledge');
    expect(rows[0]?.subject_id).toBe('k_node');
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(payload.node_id).toBe('k_node');
    expect((payload.ai_proposal as { kind?: string }).kind).toBe('archive');
  });

  it('rejects propose_new with parent_id=null', async () => {
    const db = testDb();
    await expect(
      writeKnowledgeProposeEvent(db, {
        payload: { mutation: 'propose_new', name: 'x', parent_id: null },
        reasoning: 'r',
      }),
    ).rejects.toThrow(/parent_id=null/i);
  });
});

describe('applyProposeNew', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a new knowledge row with proposed_by_ai=true', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:shici', domain: 'wenyan' });
    const newId_ = await applyProposeNew(db, {
      mutation: 'propose_new',
      name: '通假字',
      parent_id: 'seed:wenyan:shici',
    });
    expect(newId_).toMatch(/^[a-z0-9]+$/);
    const rows = await db.select().from(knowledge).where(eq(knowledge.id, newId_));
    expect(rows[0]?.name).toBe('通假字');
    expect(rows[0]?.domain).toBeNull();
    expect(rows[0]?.parent_id).toBe('seed:wenyan:shici');
    expect(rows[0]?.proposed_by_ai).toBe(true);
  });

  it('rejects propose_new with parent_id=null (PR A single-domain scope)', async () => {
    const db = testDb();
    await expect(
      applyProposeNew(db, { mutation: 'propose_new', name: 'x', parent_id: null }),
    ).rejects.toThrow(/root creation.*not supported/i);
  });

  it('rejects propose_new when parent_id does not exist in knowledge', async () => {
    const db = testDb();
    await expect(
      applyProposeNew(db, { mutation: 'propose_new', name: 'x', parent_id: 'ghost-parent' }),
    ).rejects.toThrow(/parent knowledge node not found.*ghost-parent/i);
  });
});

describe('acceptProposal (propose_new only)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('accepts pending propose_new event: inserts knowledge + writes rate=accept event', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:shici', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p1',
      payload: {
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      },
    });
    const result = await acceptProposal(db, 'p1');
    expect(result.kind).toBe('propose_new_applied');
    if (result.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    expect(result.new_node_id).toMatch(/^[a-z0-9]+$/);
    const knowledgeRows = await db
      .select()
      .from(knowledge)
      .where(eq(knowledge.id, result.new_node_id));
    expect(knowledgeRows).toHaveLength(1);
    // rate=accept event chained
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p1')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as Record<string, unknown>).rating).toBe('accept');
  });

  it('rejects accept on already-decided proposal', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'parent_x' });
    await insertProposeEvent({
      id: 'p2',
      payload: { mutation: 'propose_new', name: 'x', parent_id: 'parent_x' },
      rate: 'accept',
    });
    await expect(acceptProposal(db, 'p2')).rejects.toThrow(/not.*pending/i);
  });

  it('rejects accept when parent_id does not exist', async () => {
    const db = testDb();
    await insertProposeEvent({
      id: 'p5',
      payload: { mutation: 'propose_new', name: 'x', parent_id: 'ghost-parent' },
    });
    await expect(acceptProposal(db, 'p5')).rejects.toThrow(
      /parent knowledge node not found.*ghost-parent/i,
    );
  });
});

describe('dismissProposal', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes rate=dismiss event chained to propose', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'parent_x' });
    await insertProposeEvent({
      id: 'p4',
      payload: { mutation: 'propose_new', name: 'x', parent_id: 'parent_x' },
    });
    await dismissProposal(db, 'p4');
    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p4')));
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as Record<string, unknown>).rating).toBe('dismiss');
  });

  it('idempotent on already-rated proposal', async () => {
    const db = testDb();
    await insertProposeEvent({
      id: 'p_dismissed',
      payload: { mutation: 'propose_new', name: 'x', parent_id: 'parent_x' },
      rate: 'dismiss',
    });
    await dismissProposal(db, 'p_dismissed');
    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p_dismissed')));
    // No second rate event added — idempotent
    expect(rows).toHaveLength(1);
  });
});

describe('applyReparent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('moves a child node to a new parent (happy path)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_oldparent', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_newparent', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_node', domain: null, parent_id: 'k_oldparent', version: 3 });
    await applyReparent(db, {
      mutation: 'reparent',
      node_id: 'k_node',
      new_parent_id: 'k_newparent',
      expected_version: 3,
    });
    const rows = await db
      .select({ parent_id: knowledge.parent_id, version: knowledge.version })
      .from(knowledge)
      .where(eq(knowledge.id, 'k_node'));
    expect(rows[0]?.parent_id).toBe('k_newparent');
    expect(rows[0]?.version).toBe(4);
  });

  it('rejects reparent → null (root creation, PR A guard)', async () => {
    const db = testDb();
    await expect(
      applyReparent(db, {
        mutation: 'reparent',
        node_id: 'k_node',
        new_parent_id: null,
        expected_version: 3,
      }),
    ).rejects.toThrow(/root.*not supported/i);
  });

  it('rejects when parent is archived', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_archived', archived: true });
    await expect(
      applyReparent(db, {
        mutation: 'reparent',
        node_id: 'k_node',
        new_parent_id: 'k_archived',
        expected_version: 1,
      }),
    ).rejects.toThrow(/parent.*not found/i);
  });

  it('throws stale error when version mismatch (changes=0)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_newparent', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_node', domain: null, parent_id: 'k_newparent', version: 5 });
    await expect(
      applyReparent(db, {
        mutation: 'reparent',
        node_id: 'k_node',
        new_parent_id: 'k_newparent',
        expected_version: 3,
      }),
    ).rejects.toThrow(/stale.*version/i);
  });
});

describe('applyArchive', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('archives a node and bumps version (happy path)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_node', version: 5 });
    await applyArchive(db, {
      mutation: 'archive',
      node_id: 'k_node',
      expected_version: 5,
    });
    const rows = await db
      .select({ archived_at: knowledge.archived_at, version: knowledge.version })
      .from(knowledge)
      .where(eq(knowledge.id, 'k_node'));
    expect(rows[0]?.archived_at).toBeTruthy();
    expect(rows[0]?.version).toBe(6);
  });

  it('throws stale error when already archived (changes=0)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_node', archived: true, version: 5 });
    await expect(
      applyArchive(db, {
        mutation: 'archive',
        node_id: 'k_node',
        expected_version: 5,
      }),
    ).rejects.toThrow(/stale/i);
  });
});

describe('applySplit', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('archives from + inserts N new children (happy path)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_p1', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_p2', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_from', domain: null, parent_id: 'k_p1', version: 7 });
    const newIds = await applySplit(db, {
      mutation: 'split',
      from_id: 'k_from',
      into: [
        { name: 'A', parent_id: 'k_p1' },
        { name: 'B', parent_id: 'k_p2' },
      ],
      expected_version: 7,
    });
    expect(newIds).toHaveLength(2);
    const fromRows = await db
      .select({ archived_at: knowledge.archived_at })
      .from(knowledge)
      .where(eq(knowledge.id, 'k_from'));
    expect(fromRows[0]?.archived_at).toBeTruthy();
    const newRows = await db.select().from(knowledge).where(eq(knowledge.id, newIds[0]));
    expect(newRows).toHaveLength(1);
  });

  it('rejects split with into[].parent_id=null (root creation)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_from', version: 1 });
    await expect(
      applySplit(db, {
        mutation: 'split',
        from_id: 'k_from',
        into: [{ name: 'A', parent_id: null }],
        expected_version: 1,
      }),
    ).rejects.toThrow(/root.*not supported/i);
  });

  it('throws stale when archive UPDATE returns 0 changes', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_p1', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_from', domain: null, parent_id: 'k_p1', version: 7 });
    await expect(
      applySplit(db, {
        mutation: 'split',
        from_id: 'k_from',
        into: [{ name: 'A', parent_id: 'k_p1' }],
        expected_version: 3,
      }),
    ).rejects.toThrow(/stale/i);
  });
});

describe('applyMerge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('archives all from_ids + pushes to into.merged_from (happy path)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_into', domain: 'wenyan', version: 1, merged_from: [] });
    await insertKnowledge({ id: 'k_from1', domain: 'wenyan', version: 2 });
    await insertKnowledge({ id: 'k_from2', domain: 'wenyan', version: 4 });
    await applyMerge(db, {
      mutation: 'merge',
      from_ids: ['k_from1', 'k_from2'],
      into_id: 'k_into',
      expected_versions: { k_from1: 2, k_from2: 4 },
    });
    const from1 = await db
      .select({ archived_at: knowledge.archived_at })
      .from(knowledge)
      .where(eq(knowledge.id, 'k_from1'));
    expect(from1[0]?.archived_at).toBeTruthy();
    const into = await db
      .select({ merged_from: knowledge.merged_from })
      .from(knowledge)
      .where(eq(knowledge.id, 'k_into'));
    expect(into[0]?.merged_from).toContain('k_from1');
    expect(into[0]?.merged_from).toContain('k_from2');
  });

  it('rejects when into_id is in from_ids', async () => {
    const db = testDb();
    await expect(
      applyMerge(db, {
        mutation: 'merge',
        from_ids: ['k_a', 'k_into'],
        into_id: 'k_into',
        expected_versions: { k_a: 1, k_into: 1 },
      }),
    ).rejects.toThrow(/into_id.*from_ids/i);
  });

  it('rejects when expected_versions missing for a from_id', async () => {
    const db = testDb();
    await expect(
      applyMerge(db, {
        mutation: 'merge',
        from_ids: ['k_a', 'k_b'],
        into_id: 'k_into',
        expected_versions: { k_a: 1 },
      }),
    ).rejects.toThrow(/expected_versions.*k_b/i);
  });

  it('throws stale when any archive UPDATE returns 0 changes', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_into', domain: 'wenyan', version: 1 });
    await insertKnowledge({ id: 'k_from1', domain: 'wenyan', version: 2 });
    await expect(
      applyMerge(db, {
        mutation: 'merge',
        from_ids: ['k_from1'],
        into_id: 'k_into',
        expected_versions: { k_from1: 99 },
      }),
    ).rejects.toThrow(/stale/i);
  });

  it('reports into_id missing as stale (not the from_id)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_from1', domain: 'wenyan', version: 2 });
    await expect(
      applyMerge(db, {
        mutation: 'merge',
        from_ids: ['k_from1'],
        into_id: 'k_into_missing',
        expected_versions: { k_from1: 2 },
      }),
    ).rejects.toThrow(/stale.*into_id.*k_into_missing/i);
  });
});

// YUK-543 — merge attribution repair across the 9 surfaces.
describe('applyMerge — YUK-543 attribution repair', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const CREATED_BY = { actor_kind: 'user', actor_ref: 'self' } as never;
  async function insertQ(id: string, kids: string[]) {
    const now = new Date();
    await testDb().insert(question).values({
      id,
      kind: 'short_answer',
      prompt_md: 'p',
      knowledge_ids: kids,
      source: 'test',
      created_at: now,
      updated_at: now,
    });
  }
  async function insertLI(id: string, kids: string[]) {
    const now = new Date();
    await testDb().insert(learning_item).values({
      id,
      source: 'test',
      title: 't',
      knowledge_ids: kids,
      created_at: now,
      updated_at: now,
    });
  }
  async function insertG(id: string, scope: string[]) {
    const now = new Date();
    await testDb().insert(goal).values({
      id,
      title: 'g',
      source: 'test',
      scope_knowledge_ids: scope,
      created_at: now,
      updated_at: now,
    });
  }
  async function insertEdge(id: string, from: string, to: string, relation: string) {
    await testDb().insert(knowledge_edge).values({
      id,
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: relation,
      created_by: CREATED_BY,
    });
  }
  async function insertMisc(id: string, toId: string) {
    const now = new Date();
    await testDb().insert(misconception_edge).values({
      id,
      from_kind: 'misconception',
      from_id: 'm1',
      to_kind: 'knowledge',
      to_id: toId,
      relation_type: 'confusable_with',
      created_by: CREATED_BY,
      created_at: now,
      updated_at: now,
    });
  }
  async function mergeFromInto(from: string, into: string) {
    return applyMerge(testDb(), {
      mutation: 'merge',
      from_ids: [from],
      into_id: into,
      expected_versions: { [from]: 0 },
    });
  }

  it('rewrites question.knowledge_ids (replace + dedupe)', async () => {
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await insertQ('q1', ['k_from', 'k_x']);
    await insertQ('q2', ['k_into', 'k_from']); // dedupe: from→into collapses onto existing into
    const log = await mergeFromInto('k_from', 'k_into');
    expect(log[0].question_ids_rewritten.sort()).toEqual(['q1', 'q2']);
    const q1 = await testDb().select().from(question).where(eq(question.id, 'q1'));
    const q2 = await testDb().select().from(question).where(eq(question.id, 'q2'));
    expect(q1[0].knowledge_ids).toEqual(['k_into', 'k_x']);
    expect(q2[0].knowledge_ids).toEqual(['k_into']);
  });

  it('rewrites learning_item.knowledge_ids and goal.scope_knowledge_ids', async () => {
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await insertLI('li1', ['k_from']);
    await insertG('g1', ['k_from', 'k_y']);
    const log = await mergeFromInto('k_from', 'k_into');
    expect(log[0].learning_item_ids_rewritten).toEqual(['li1']);
    expect(log[0].goal_ids_rewritten).toEqual(['g1']);
    const li = await testDb().select().from(learning_item).where(eq(learning_item.id, 'li1'));
    const g = await testDb().select().from(goal).where(eq(goal.id, 'g1'));
    expect(li[0].knowledge_ids).toEqual(['k_into']);
    expect(g[0].scope_knowledge_ids).toEqual(['k_into', 'k_y']);
    // goal rewrite reuses updateGoalScope → version bump (fold-visible event written).
    expect(g[0].version).toBe(1);
  });

  it('rewires a knowledge_edge endpoint (archive old + create rewritten + fold events)', async () => {
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await insertKnowledge({ id: 'k_x', version: 0 });
    await insertEdge('e1', 'k_from', 'k_x', 'related_to');
    const log = await mergeFromInto('k_from', 'k_into');
    expect(log[0].edges_rewired).toHaveLength(1);
    expect(log[0].edges_rewired[0].old_edge_id).toBe('e1');
    expect(log[0].edges_rewired[0].new_edge_id).not.toBeNull();
    // old archived, new live edge k_into --related_to--> k_x.
    const e1 = await testDb().select().from(knowledge_edge).where(eq(knowledge_edge.id, 'e1'));
    expect(e1[0].archived_at).not.toBeNull();
    const live = await testDb()
      .select()
      .from(knowledge_edge)
      .where(
        and(
          eq(knowledge_edge.from_knowledge_id, 'k_into'),
          eq(knowledge_edge.to_knowledge_id, 'k_x'),
        ),
      );
    expect(live).toHaveLength(1);
    // a fold-visible generate(create) event was written for the new edge.
    const genEvents = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'generate'), eq(event.subject_kind, 'knowledge_edge')));
    expect(genEvents.length).toBeGreaterThanOrEqual(2); // one archive + one create
  });

  it('edge collision post-rewrite → archive-as-duplicate (new_edge_id null, no new edge)', async () => {
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await insertKnowledge({ id: 'k_x', version: 0 });
    await insertEdge('e_from', 'k_from', 'k_x', 'related_to');
    await insertEdge('e_into', 'k_into', 'k_x', 'related_to'); // the rewritten key already exists
    const log = await mergeFromInto('k_from', 'k_into');
    expect(log[0].edges_rewired).toEqual([{ old_edge_id: 'e_from', new_edge_id: null }]);
    const eFrom = await testDb()
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'e_from'));
    expect(eFrom[0].archived_at).not.toBeNull(); // archived, not re-created
    const eInto = await testDb()
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, 'e_into'));
    expect(eInto[0].archived_at).toBeNull(); // the surviving edge is untouched
  });

  it('prerequisite topology reject on the rewritten edge ABORTS the whole merge tx', async () => {
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await insertKnowledge({ id: 'k_x', version: 0 });
    // existing: k_into --prereq--> k_x. Rewriting (k_x --prereq--> k_from) → (k_x --prereq--> k_into)
    // reverses the existing edge = direction contradiction → reject → abort.
    await insertEdge('e_keep', 'k_into', 'k_x', 'prerequisite');
    await insertEdge('e_bad', 'k_x', 'k_from', 'prerequisite');
    await expect(mergeFromInto('k_from', 'k_into')).rejects.toThrow(/topology|aborting merge/i);
    // whole tx rolled back: k_from still LIVE, edges unchanged.
    const kf = await testDb().select().from(knowledge).where(eq(knowledge.id, 'k_from'));
    expect(kf[0].archived_at).toBeNull();
    const eBad = await testDb().select().from(knowledge_edge).where(eq(knowledge_edge.id, 'e_bad'));
    expect(eBad[0].archived_at).toBeNull();
  });

  it('rewrites misconception_edge.to_id (to_kind=knowledge)', async () => {
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await insertMisc('mc1', 'k_from');
    const log = await mergeFromInto('k_from', 'k_into');
    expect(log[0].misconception_edges_rewritten).toEqual(['mc1']);
    const mc = await testDb()
      .select()
      .from(misconception_edge)
      .where(eq(misconception_edge.id, 'mc1'));
    expect(mc[0].to_id).toBe('k_into');
  });

  it('multi-from_id ordering: first from renames mastery, second freezes (deterministic)', async () => {
    await insertKnowledge({ id: 'k_from1', version: 0 });
    await insertKnowledge({ id: 'k_from2', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await testDb().insert(mastery_state).values({ id: 'ms1', subject_id: 'k_from1' });
    await testDb().insert(mastery_state).values({ id: 'ms2', subject_id: 'k_from2' });
    // into is cold (no mastery row).
    const log = await applyMerge(testDb(), {
      mutation: 'merge',
      from_ids: ['k_from1', 'k_from2'],
      into_id: 'k_into',
      expected_versions: { k_from1: 0, k_from2: 0 },
    });
    // from1 renames its row onto the cold into; from2 then sees into occupied → freeze.
    expect(log[0].from_id).toBe('k_from1');
    expect(log[0].mastery_state).toBe('renamed');
    expect(log[1].from_id).toBe('k_from2');
    expect(log[1].mastery_state).toBe('frozen');
    const rows = await testDb().select().from(mastery_state);
    expect(rows.map((r) => r.subject_id).sort()).toEqual(['k_from2', 'k_into']);
  });

  it('kc_typed_state pointer rewrite via applyMerge', async () => {
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await testDb()
      .insert(kc_typed_state)
      .values({ id: 'kt_other', subject_id: 'k_other', confused_with_kc_id: 'k_from' });
    await mergeFromInto('k_from', 'k_into');
    const kt = await testDb()
      .select()
      .from(kc_typed_state)
      .where(eq(kc_typed_state.subject_id, 'k_other'));
    expect(kt[0].confused_with_kc_id).toBe('k_into');
  });

  it('accept path: event-sourced learning_item folds == the merge-rewritten row (parity holds)', async () => {
    const now0 = new Date('2026-07-02T00:00:00.000Z');
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    // learning_item seeded WITH a genesis anchor (event-sourced) so the parity assert actually runs.
    const liRow = {
      id: 'li1',
      source: 'learning_intent',
      source_ref: null,
      title: 't',
      content: '',
      knowledge_ids: ['k_from', 'k_y'],
      primary_artifact_id: null,
      parent_learning_item_id: null,
      status: 'pending',
      user_pinned: false,
      completed_at: null,
      dismissed_at: null,
      archived_at: null,
      archived_reason: null,
      created_at: now0,
      updated_at: now0,
      version: 0,
    };
    await testDb().insert(learning_item).values(liRow);
    await testDb()
      .insert(event)
      .values({
        id: 'gen_li1',
        session_id: null,
        actor_kind: 'system',
        actor_ref: 'genesis-backfill',
        action: 'experimental:genesis',
        subject_kind: 'learning_item',
        subject_id: 'li1',
        outcome: 'success',
        payload: { row: liRow },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now0,
      });
    await insertProposeEvent({
      id: 'merge_li',
      payload: {
        mutation: 'merge',
        from_ids: ['k_from'],
        into_id: 'k_into',
        expected_versions: { k_from: 0 },
      },
    });
    // If the fold did NOT reproduce the rewritten row, assertLearningItemParity throws here (test env).
    await acceptProposal(testDb(), 'merge_li');
    const li = await testDb().select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(li[0].knowledge_ids).toEqual(['k_into', 'k_y']);
    expect(li[0].updated_at).toEqual(now0); // merge rewrite touches ONLY knowledge_ids
  });

  it('acceptProposal on a merge pins merge_repair on the rate=accept event', async () => {
    await insertKnowledge({ id: 'k_from', version: 0 });
    await insertKnowledge({ id: 'k_into', version: 0 });
    await insertQ('q1', ['k_from']);
    await insertProposeEvent({
      id: 'merge_prop',
      payload: {
        mutation: 'merge',
        from_ids: ['k_from'],
        into_id: 'k_into',
        expected_versions: { k_from: 0 },
      },
    });
    await acceptProposal(testDb(), 'merge_prop');
    const rate = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'merge_prop')));
    const payload = rate[0].payload as {
      rating: string;
      merge_repair?: Array<{ from_id: string }>;
    };
    expect(payload.rating).toBe('accept');
    expect(payload.merge_repair).toBeDefined();
    expect(payload.merge_repair?.[0].from_id).toBe('k_from');
    // the question was rewritten as part of the accept.
    const q1 = await testDb().select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_into']);
  });
});

describe('acceptProposal — high-tier mutations', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('dispatches reparent and returns reparent_applied result', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_oldparent', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_newparent', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_node', domain: null, parent_id: 'k_oldparent', version: 3 });
    await insertProposeEvent({
      id: 'p_reparent',
      payload: {
        mutation: 'reparent',
        node_id: 'k_node',
        new_parent_id: 'k_newparent',
        expected_version: 3,
      },
    });
    const result = await acceptProposal(db, 'p_reparent');
    expect(result.kind).toBe('reparent_applied');
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p_reparent')));
    expect((rateRows[0].payload as Record<string, unknown>).rating).toBe('accept');
  });

  it('dispatches archive and returns archive_applied result', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_node', version: 5 });
    await insertProposeEvent({
      id: 'p_arch',
      payload: {
        mutation: 'archive',
        node_id: 'k_node',
        expected_version: 5,
      },
    });
    const result = await acceptProposal(db, 'p_arch');
    expect(result.kind).toBe('archive_applied');
  });

  it('marks proposal stale on stale error and re-throws', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_node', version: 5 });
    await insertProposeEvent({
      id: 'p_stale',
      payload: {
        mutation: 'archive',
        node_id: 'k_node',
        expected_version: 3,
      },
    });
    await expect(acceptProposal(db, 'p_stale')).rejects.toThrow(/stale/i);
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p_stale')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as Record<string, unknown>).rating).toBe('rollback');
  });

  it('throws unknown_mutation when payload has unrecognized mutation kind', async () => {
    const db = testDb();
    // Manually insert experimental:knowledge_frobnicate event with bogus mutation
    await insertProposeEvent({
      id: 'p_bad',
      payload: { mutation: 'frobnicate', node_id: 'k_x' },
    });
    await expect(acceptProposal(db, 'p_bad')).rejects.toThrow(/unknown_mutation/i);
  });

  // Codex P2-I — dismiss must reject non-proposal events.
  it('dismissProposal throws when the event id is not a proposal (e.g., attempt event)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(event).values({
      id: 'attempt_e1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
    await expect(dismissProposal(db, 'attempt_e1')).rejects.toThrow(/not a proposal/i);
    // No rate event was written.
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'attempt_e1')));
    expect(rateRows).toHaveLength(0);
  });

  // Codex P1-F — concurrent double-accept must not produce duplicate
  // knowledge nodes / duplicate rate=accept events. assertNotAlreadyRated +
  // mutation apply must share a transaction with SELECT … FOR UPDATE on the
  // propose event row, otherwise both callers pass the pre-check and apply.
  it('concurrent double-accept: exactly one apply succeeds', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:shici', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_concurrent',
      payload: {
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      },
    });

    const results = await Promise.allSettled([
      acceptProposal(db, 'p_concurrent'),
      acceptProposal(db, 'p_concurrent'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one succeeds; the other sees the rate event already written and
    // throws not-pending.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one new knowledge node from this proposal (not two).
    // proposed_by_ai=true filters out the seed knowledge nodes.
    const proposedRows = await db
      .select()
      .from(knowledge)
      .where(eq(knowledge.proposed_by_ai, true));
    expect(proposedRows).toHaveLength(1);

    // Exactly one rate=accept event (not two).
    const acceptRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p_concurrent')));
    expect(
      acceptRows.filter((r) => (r.payload as { rating?: string }).rating === 'accept'),
    ).toHaveLength(1);
  });
});

// =============================================================================
// YUK-471 W1 PR-A2b — accept-path projection wiring. After acceptProposal the
// rate=accept event must carry materialized_ids, the reverse index must record
// (mintedId → proposalId), and gatherAndFoldKnowledgeNode(db, id) must deep-equal
// the live row (the parity the PR-B double-write phase will assert). For minting
// mutations (propose_new / split) timestamps now come from a single accept-time
// `now`, so created_at/updated_at match too.
// =============================================================================

describe('acceptProposal — PR-A2b projection parity', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('propose_new accept: rate carries materialized_ids, index row written, fold == row', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:shici', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_a2b_new',
      payload: { mutation: 'propose_new', name: '通假字', parent_id: 'seed:wenyan:shici' },
    });

    const result = await acceptProposal(db, 'p_a2b_new');
    expect(result.kind).toBe('propose_new_applied');
    if (result.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    const newId_ = result.new_node_id;

    // (a) rate=accept payload carries materialized_ids.knowledge = [newId]
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p_a2b_new')));
    expect(rateRows).toHaveLength(1);
    const ratePayload = rateRows[0].payload as {
      rating: string;
      materialized_ids?: { knowledge?: string[] };
    };
    expect(ratePayload.rating).toBe('accept');
    expect(ratePayload.materialized_ids?.knowledge).toEqual([newId_]);

    // (b) materialized_id_index row: newId → proposalId, subject_kind='knowledge'
    const idxRows = await db
      .select()
      .from(materialized_id_index)
      .where(eq(materialized_id_index.materialized_id, newId_));
    expect(idxRows).toHaveLength(1);
    expect(idxRows[0].anchor_event_id).toBe('p_a2b_new');
    expect(idxRows[0].subject_kind).toBe('knowledge');

    // (c) fold(events) deep-equals the live structural row (incl created_at/updated_at)
    const folded = await gatherAndFoldKnowledgeNode(db, newId_);
    const live = await liveSnapshot(newId_);
    expect(live).not.toBeNull();
    expect(folded).toEqual(live);
  });

  it('split accept: N minted ids in materialized_ids + index; fold == row for each new node', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_p1', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_p2', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_from', domain: null, parent_id: 'k_p1', version: 7 });
    // split subject_id convention = from_id (mutationSubjectId proposals.ts:30-42)
    await insertProposeEvent({
      id: 'p_a2b_split',
      subject_id: 'k_from',
      payload: {
        mutation: 'split',
        from_id: 'k_from',
        into: [
          { name: 'A', parent_id: 'k_p1' },
          { name: 'B', parent_id: 'k_p2' },
        ],
        expected_version: 7,
      },
    });

    const result = await acceptProposal(db, 'p_a2b_split');
    expect(result.kind).toBe('split_applied');
    if (result.kind !== 'split_applied') throw new Error('unexpected kind');
    const newIds = result.new_node_ids;
    expect(newIds).toHaveLength(2);

    // (a) rate=accept payload carries all N minted ids
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p_a2b_split')));
    expect(rateRows).toHaveLength(1);
    const ratePayload = rateRows[0].payload as {
      rating: string;
      materialized_ids?: { knowledge?: string[] };
    };
    expect(ratePayload.materialized_ids?.knowledge).toEqual(newIds);

    // (b) one index row per minted id, all anchored to the split proposal
    for (const id of newIds) {
      const idxRows = await db
        .select()
        .from(materialized_id_index)
        .where(eq(materialized_id_index.materialized_id, id));
      expect(idxRows).toHaveLength(1);
      expect(idxRows[0].anchor_event_id).toBe('p_a2b_split');
    }

    // (c) fold == row for each newly minted node (created from accept-time `now`)
    for (const id of newIds) {
      const folded = await gatherAndFoldKnowledgeNode(db, id);
      const live = await liveSnapshot(id);
      expect(live).not.toBeNull();
      expect(folded).toEqual(live);
    }
  });

  it('reparent accept: no materialized_ids; fold == row with accept-time timestamps', async () => {
    const db = testDb();
    // Seed the node via a propose_new accept so its genesis lives in the event log
    // (gatherAndFoldKnowledgeNode reconstructs from events, not from a bare INSERT).
    await insertKnowledge({ id: 'k_oldparent', domain: 'wenyan' });
    await insertKnowledge({ id: 'k_newparent', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_seed_node',
      payload: { mutation: 'propose_new', name: 'movable', parent_id: 'k_oldparent' },
    });
    const seed = await acceptProposal(db, 'p_seed_node');
    if (seed.kind !== 'propose_new_applied') throw new Error('seed failed');
    const nodeId = seed.new_node_id;

    // Reparent that node. The node currently has version 0 (createRow seeds 0).
    await insertProposeEvent({
      id: 'p_a2b_reparent',
      subject_id: nodeId,
      payload: {
        mutation: 'reparent',
        node_id: nodeId,
        new_parent_id: 'k_newparent',
        expected_version: 0,
      },
    });
    const result = await acceptProposal(db, 'p_a2b_reparent');
    expect(result.kind).toBe('reparent_applied');

    // No materialized_ids on a reparent accept (mints nothing).
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p_a2b_reparent')));
    expect(rateRows).toHaveLength(1);
    const ratePayload = rateRows[0].payload as { materialized_ids?: unknown };
    expect(ratePayload.materialized_ids).toBeUndefined();

    // fold == row: parent moved, version bumped, updated_at = reparent accept-time.
    const folded = await gatherAndFoldKnowledgeNode(db, nodeId);
    const live = await liveSnapshot(nodeId);
    expect(live).not.toBeNull();
    expect(live?.parent_id).toBe('k_newparent');
    expect(live?.version).toBe(1);
    expect(folded).toEqual(live);
  });

  it('archive accept: no materialized_ids; fold == row with archived_at from accept-time', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_arch_parent', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'p_seed_arch',
      payload: { mutation: 'propose_new', name: 'doomed', parent_id: 'k_arch_parent' },
    });
    const seed = await acceptProposal(db, 'p_seed_arch');
    if (seed.kind !== 'propose_new_applied') throw new Error('seed failed');
    const nodeId = seed.new_node_id;

    await insertProposeEvent({
      id: 'p_a2b_archive',
      subject_id: nodeId,
      payload: { mutation: 'archive', node_id: nodeId, expected_version: 0 },
    });
    const result = await acceptProposal(db, 'p_a2b_archive');
    expect(result.kind).toBe('archive_applied');

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'p_a2b_archive')));
    expect(rateRows).toHaveLength(1);
    const ratePayload = rateRows[0].payload as { materialized_ids?: unknown };
    expect(ratePayload.materialized_ids).toBeUndefined();

    const folded = await gatherAndFoldKnowledgeNode(db, nodeId);
    const live = await liveSnapshot(nodeId);
    expect(live).not.toBeNull();
    expect(live?.archived_at).toBeTruthy();
    expect(live?.version).toBe(1);
    expect(folded).toEqual(live);
  });
});

// =============================================================================
// YUK-471 W1 PR-B1 — propose_new SoT flip (PROJECTION_IS_WRITER). Flag ON: the
// imperative applier INSERT is SKIPPED (writeRow=false); the projection writes the
// row from events at the accept seam. The row must EXIST (proving the seam fired —
// without the projection call it would be absent) and equal its own fold, and be
// structurally identical to the flag-OFF imperative row. Flag OFF keeps A2b behavior
// (imperative write + parity assert) — the rollback state.
// =============================================================================

function stripVolatile(r: {
  name: string;
  domain: string | null;
  parent_id: string | null;
  merged_from: string[];
  proposed_by_ai: boolean;
  approval_status: string;
  version: number;
  archived_at: Date | null;
}) {
  // id + created_at/updated_at differ across runs by construction (fresh mint + fresh `now`);
  // compare only the structural fields the imperative writer and the projection must agree on.
  return {
    name: r.name,
    domain: r.domain,
    parent_id: r.parent_id,
    merged_from: r.merged_from,
    proposed_by_ai: r.proposed_by_ai,
    approval_status: r.approval_status,
    version: r.version,
    archived_at: r.archived_at,
  };
}

describe('acceptProposal — PR-B1 propose_new SoT flip (PROJECTION_IS_WRITER)', () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('flag OFF (default): imperative INSERT writes the row; A2b fold==row holds', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:p', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'pb1_off',
      payload: { mutation: 'propose_new', name: '通假字', parent_id: 'seed:wenyan:p' },
    });
    const result = await acceptProposal(db, 'pb1_off');
    if (result.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    const live = await liveSnapshot(result.new_node_id);
    expect(live).not.toBeNull();
    const folded = await gatherAndFoldKnowledgeNode(db, result.new_node_id);
    expect(folded).toEqual(live);
  });

  it('flag ON: the projection writes the row (imperative INSERT skipped) — row exists and equals its fold', async () => {
    vi.stubEnv('PROJECTION_IS_WRITER', '1');
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:p', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'pb1_on',
      payload: { mutation: 'propose_new', name: '通假字', parent_id: 'seed:wenyan:p' },
    });
    const result = await acceptProposal(db, 'pb1_on');
    if (result.kind !== 'propose_new_applied') throw new Error('unexpected kind');

    // The imperative INSERT was skipped (writeRow=false). The row EXISTS only because the
    // projection wrote it from the events — a broken seam would leave the row absent.
    const live = await liveSnapshot(result.new_node_id);
    expect(live).not.toBeNull();
    const folded = await gatherAndFoldKnowledgeNode(db, result.new_node_id);
    expect(folded).toEqual(live);
  });

  it('flag ON vs OFF: the projected row is structurally identical to the imperative row', async () => {
    const db = testDb();
    // OFF run
    await insertKnowledge({ id: 'seed:wenyan:p', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'pb1_cmp_off',
      payload: { mutation: 'propose_new', name: '互文', parent_id: 'seed:wenyan:p' },
    });
    const off = await acceptProposal(db, 'pb1_cmp_off');
    if (off.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    const offRow = await liveSnapshot(off.new_node_id);

    await resetDb();

    // ON run (fresh DB, same shape)
    vi.stubEnv('PROJECTION_IS_WRITER', '1');
    await insertKnowledge({ id: 'seed:wenyan:p', domain: 'wenyan' });
    await insertProposeEvent({
      id: 'pb1_cmp_on',
      payload: { mutation: 'propose_new', name: '互文', parent_id: 'seed:wenyan:p' },
    });
    const on = await acceptProposal(db, 'pb1_cmp_on');
    if (on.kind !== 'propose_new_applied') throw new Error('unexpected kind');
    const onRow = await liveSnapshot(on.new_node_id);

    expect(offRow).not.toBeNull();
    expect(onRow).not.toBeNull();
    if (!offRow || !onRow) throw new Error('rows missing');
    expect(stripVolatile(onRow)).toEqual(stripVolatile(offRow));
  });
});

// =============================================================================
// YUK-471 W1 PR-B (full flip) — the keystone NON-DELETE guard + mutation projection.
// The full flip generalizes the seam to project EVERY touched node (guarded). The guard
// is what makes activation safe before backfill: a touched node that folds to null but has
// NO genesis anchor (a seed root / any pre-event-sourced row) must be LEFT INTACT, never
// deleted. A naive (unguarded) flip would DELETE it on a normal merge/reparent/archive.
// =============================================================================

describe('acceptProposal — PR-B full flip: keystone non-delete guard + mutation projection', () => {
  beforeEach(async () => {
    vi.unstubAllEnvs();
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('flag ON: merge into a SEED ROOT (no events / no anchor) leaves BOTH rows surviving — guard skips the delete', async () => {
    const db = testDb();
    // Seed root + a from node, BOTH inserted directly with NO events (pre-event-sourced).
    await insertKnowledge({ id: 'seed_root', domain: 'wenyan', version: 0, merged_from: [] });
    await insertKnowledge({ id: 'k_from_seed', domain: 'wenyan', version: 0 });
    await insertProposeEvent({
      id: 'p_merge_seed',
      subject_id: 'seed_root',
      payload: {
        mutation: 'merge',
        from_ids: ['k_from_seed'],
        into_id: 'seed_root',
        expected_versions: { k_from_seed: 0 },
      },
    });

    vi.stubEnv('PROJECTION_IS_WRITER', '1');
    const result = await acceptProposal(db, 'p_merge_seed');
    expect(result.kind).toBe('merge_applied');

    // The seam projects [seed_root, k_from_seed] GUARDED. Both fold to null (no creating
    // event) and have NO genesis anchor → the guard SKIPS the delete. A naive unguarded
    // projection would DELETE both = data loss. Assert BOTH rows survive.
    const root = await liveSnapshot('seed_root');
    const from = await liveSnapshot('k_from_seed');
    expect(root).not.toBeNull(); // seed root NOT deleted (this is the keystone)
    expect(from).not.toBeNull(); // from node NOT deleted (only soft-archived)
    // The imperative mutation still applied: into.merged_from gained the from; from archived.
    expect(root?.merged_from).toContain('k_from_seed');
    expect(from?.archived_at).toBeTruthy();
  });

  it('flag ON vs OFF: reparent of an EVENT-SOURCED node projects a structurally identical row', async () => {
    // run() builds an event-sourced node via a propose_new accept (so it HAS a genesis anchor),
    // then reparents it under the given flag and returns the structural row.
    async function run(flip: boolean) {
      await resetDb();
      const db = testDb();
      await insertKnowledge({ id: 'rp_oldp', domain: 'wenyan' });
      await insertKnowledge({ id: 'rp_newp', domain: 'wenyan' });
      await insertProposeEvent({
        id: 'p_seed_rp',
        payload: { mutation: 'propose_new', name: 'movable', parent_id: 'rp_oldp' },
      });
      const seed = await acceptProposal(db, 'p_seed_rp'); // flag OFF — imperative create
      if (seed.kind !== 'propose_new_applied') throw new Error('seed');
      const nodeId = seed.new_node_id;
      await insertProposeEvent({
        id: 'p_rp',
        subject_id: nodeId,
        payload: {
          mutation: 'reparent',
          node_id: nodeId,
          new_parent_id: 'rp_newp',
          expected_version: 0,
        },
      });
      if (flip) vi.stubEnv('PROJECTION_IS_WRITER', '1');
      const r = await acceptProposal(db, 'p_rp');
      if (r.kind !== 'reparent_applied') throw new Error('reparent');
      vi.unstubAllEnvs();
      const row = await liveSnapshot(nodeId);
      return row ? stripVolatile(row) : null;
    }
    const off = await run(false);
    const on = await run(true);
    expect(off).not.toBeNull();
    expect(on).not.toBeNull();
    // Projection-written reparent row == imperative reparent row (parent moved, version bumped).
    expect(on).toEqual(off);
    expect(on?.parent_id).toBe('rp_newp');
    expect(on?.version).toBe(1);
  });
});
