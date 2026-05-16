// Phase 1c.1 Step 9.D — proposals.test rewritten for event-based handlers.
//
// Pre-Step-9 tests INSERTed dreaming_proposal rows; post-Step-9 the legacy
// table is gone. Seed propose events directly + assert event-driven flow.

import { event, knowledge } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  reasoning?: string;
  action?: string;
  subject_id?: string;
  // rate event chained to this propose to simulate already-decided
  rate?: 'accept' | 'dismiss' | 'rollback';
}) {
  const db = testDb();
  const now = new Date();
  const action = opts.action ?? (opts.payload.mutation === 'propose_new'
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
    subject_id: opts.subject_id ?? 'subject_' + opts.id,
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

  it('writes experimental:knowledge_<mutation> event for non-propose_new mutations', async () => {
    const db = testDb();
    const id = await writeKnowledgeProposeEvent(db, {
      payload: { mutation: 'archive', node_id: 'k_node', expected_version: 5 },
      reasoning: '过时',
    });
    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows[0]?.action).toBe('experimental:knowledge_archive');
    expect(rows[0]?.subject_kind).toBe('knowledge');
    expect(rows[0]?.subject_id).toBe('k_node');
    expect((rows[0]?.payload as Record<string, unknown>).node_id).toBe('k_node');
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
      .where(
        and(
          eq(event.action, 'rate'),
          eq(event.caused_by_event_id, 'p_concurrent'),
        ),
      );
    expect(acceptRows.filter((r) => (r.payload as { rating?: string }).rating === 'accept'))
      .toHaveLength(1);
  });
});

