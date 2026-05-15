import { dreaming_proposal, knowledge } from '@/db/schema';
import { eq } from 'drizzle-orm';
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
  writeDreamingProposal,
} from './proposals';

// Helper to insert a knowledge node for tests
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

async function insertProposal(opts: {
  id: string;
  payload: object;
  status?: string;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(dreaming_proposal).values({
    id: opts.id,
    kind: 'knowledge',
    payload: opts.payload as Record<string, unknown>,
    reasoning: 'test',
    status: opts.status ?? 'pending',
    proposed_at: now,
    decided_at: opts.status && opts.status !== 'pending' ? now : null,
  });
}

describe('writeDreamingProposal', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a dreaming_proposal row with kind=knowledge', async () => {
    const db = testDb();
    const id = await writeDreamingProposal(db, {
      payload: {
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      },
      reasoning: '看 mistake 涉及通假字',
    });
    expect(id).toMatch(/^[a-z0-9]+$/);
    const rows = await db.select().from(dreaming_proposal).where(eq(dreaming_proposal.id, id));
    expect(rows[0]?.kind).toBe('knowledge');
    expect(rows[0]?.status).toBe('pending');
  });
});

describe('applyProposeNew', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a new knowledge row with proposed_by_ai=true', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:shici', domain: 'wenyan' });
    const newId = await applyProposeNew(db, {
      mutation: 'propose_new',
      name: '通假字',
      parent_id: 'seed:wenyan:shici',
    });
    expect(newId).toMatch(/^[a-z0-9]+$/);
    const rows = await db.select().from(knowledge).where(eq(knowledge.id, newId));
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

  it('accepts pending propose_new proposal: inserts knowledge + sets status', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:shici', domain: 'wenyan' });
    await insertProposal({
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
    const proposalRows = await db
      .select({ status: dreaming_proposal.status })
      .from(dreaming_proposal)
      .where(eq(dreaming_proposal.id, 'p1'));
    expect(proposalRows[0]?.status).toBe('accepted');
  });

  it('rejects accept on non-pending proposal', async () => {
    const db = testDb();
    await insertProposal({
      id: 'p2',
      payload: { mutation: 'propose_new', name: 'x', parent_id: null },
      status: 'accepted',
    });
    await expect(acceptProposal(db, 'p2')).rejects.toThrow(/not.*pending/i);
  });

  it('rejects accept when parent_id does not exist', async () => {
    const db = testDb();
    await insertProposal({
      id: 'p5',
      payload: {
        mutation: 'propose_new',
        name: 'x',
        parent_id: 'ghost-parent',
      },
    });
    await expect(acceptProposal(db, 'p5')).rejects.toThrow(
      /parent knowledge node not found.*ghost-parent/i,
    );
  });

  it('throws when concurrent accept already flipped status', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'seed:wenyan:shici', domain: 'wenyan' });
    // Insert proposal then immediately set it to accepted (simulates race)
    await insertProposal({
      id: 'p6',
      payload: {
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      },
      status: 'accepted',
    });
    await expect(acceptProposal(db, 'p6')).rejects.toThrow(/not.*pending|concurrently decided/i);
  });
});

describe('dismissProposal', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('updates status to dismissed', async () => {
    const db = testDb();
    await insertProposal({
      id: 'p4',
      payload: { mutation: 'propose_new', name: 'x', parent_id: null },
    });
    await dismissProposal(db, 'p4');
    const rows = await db
      .select({ status: dreaming_proposal.status })
      .from(dreaming_proposal)
      .where(eq(dreaming_proposal.id, 'p4'));
    expect(rows[0]?.status).toBe('dismissed');
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
        expected_version: 3, // wrong version
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
        expected_version: 3, // wrong version → stale
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
        expected_versions: { k_from1: 99 }, // wrong version → stale
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
    await insertProposal({
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
    const proposalRows = await db
      .select({ status: dreaming_proposal.status })
      .from(dreaming_proposal)
      .where(eq(dreaming_proposal.id, 'p_reparent'));
    expect(proposalRows[0]?.status).toBe('accepted');
  });

  it('dispatches archive and returns archive_applied result', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'k_node', version: 5 });
    await insertProposal({
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
    await insertProposal({
      id: 'p_stale',
      payload: {
        mutation: 'archive',
        node_id: 'k_node',
        expected_version: 3, // wrong version → stale
      },
    });
    await expect(acceptProposal(db, 'p_stale')).rejects.toThrow(/stale/i);
    const proposalRows = await db
      .select({ status: dreaming_proposal.status })
      .from(dreaming_proposal)
      .where(eq(dreaming_proposal.id, 'p_stale'));
    expect(proposalRows[0]?.status).toBe('stale');
  });

  it('throws unknown_mutation when payload has unrecognized mutation kind', async () => {
    const db = testDb();
    await insertProposal({
      id: 'p_bad',
      payload: { mutation: 'frobnicate', node_id: 'k_x' },
    });
    await expect(acceptProposal(db, 'p_bad')).rejects.toThrow(/unknown_mutation/i);
  });
});
