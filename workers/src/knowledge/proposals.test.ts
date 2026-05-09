import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import {
  writeDreamingProposal,
  applyProposeNew,
  acceptProposal,
  dismissProposal,
} from './proposals';

interface MockOptions {
  proposals?: Record<string, Record<string, unknown>>;
  knowledge?: Record<string, Record<string, unknown>>;
  /** Force the next batch's UPDATE statement to report 0 row changes (race simulation). */
  raceUpdateZeroChanges?: boolean;
  /** Force any prepare/run matching this regex to report 0 row changes (stale simulation). */
  runZeroChangesFor?: RegExp;
}

function makeMockDb(opts: MockOptions = {}) {
  const tableRows: Record<string, Record<string, Record<string, unknown>>> = {
    knowledge: { ...(opts.knowledge ?? {}) },
    dreaming_proposal: { ...(opts.proposals ?? {}) },
  };
  const calls: Array<{ sql: string; binds: unknown[] }> = [];

  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          if (/from dreaming_proposal where id = \?/i.test(sql)) {
            return tableRows.dreaming_proposal[binds[0] as string] ?? null;
          }
          if (/select id from knowledge where id = \?/i.test(sql)) {
            const row = tableRows.knowledge[binds[0] as string];
            if (!row) return null;
            if (/archived_at is null/i.test(sql) && row.archived_at != null) return null;
            return row;
          }
          return null;
        },
        run: async () => {
          if (opts.runZeroChangesFor && opts.runZeroChangesFor.test(sql)) {
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        all: async () => ({ results: Object.values(tableRows.dreaming_proposal) }),
        _sql: sql,
      };
    },
  }));
  const db = {
    prepare,
    batch: async (stmts: Array<{ run: () => Promise<unknown>; _sql?: string }>) => {
      const results: unknown[] = [];
      for (const s of stmts) {
        if (opts.raceUpdateZeroChanges && /update (dreaming_proposal|knowledge)/i.test(s._sql ?? '')) {
          results.push({ success: true, meta: { changes: 0 } });
        } else {
          results.push(await s.run());
        }
      }
      return results;
    },
  } as unknown as D1Database;
  return { db, tableRows, calls };
}

describe('writeDreamingProposal', () => {
  it('inserts a dreaming_proposal row with kind=knowledge', async () => {
    const { db, calls } = makeMockDb();
    const id = await writeDreamingProposal(db, {
      payload: {
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      },
      reasoning: '看 mistake 涉及通假字',
    });
    expect(id).toMatch(/^[a-z0-9]+$/);
    const insert = calls.find((c) => /insert into dreaming_proposal/i.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.binds[1]).toBe('knowledge'); // kind
    expect(insert?.binds[4]).toBe('pending'); // status
  });
});

describe('applyProposeNew', () => {
  it('inserts a new knowledge row with status=approved', async () => {
    const { db, calls } = makeMockDb({
      knowledge: { 'seed:wenyan:shici': { id: 'seed:wenyan:shici' } },
    });
    const newId = await applyProposeNew(db, {
      mutation: 'propose_new',
      name: '通假字',
      parent_id: 'seed:wenyan:shici',
    });
    expect(newId).toMatch(/^[a-z0-9]+$/);
    const insert = calls.find((c) => /insert into knowledge/i.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.binds[1]).toBe('通假字'); // name
    expect(insert?.binds[2]).toBeNull(); // domain (child node, inherit)
    expect(insert?.binds[3]).toBe('seed:wenyan:shici'); // parent_id
    expect(insert?.binds[7]).toBe(1); // proposed_by_ai true
  });

  it('rejects propose_new with parent_id=null (PR A single-domain scope)', async () => {
    const { db } = makeMockDb();
    await expect(
      applyProposeNew(db, { mutation: 'propose_new', name: 'x', parent_id: null }),
    ).rejects.toThrow(/root creation.*not supported/i);
  });

  it('rejects propose_new when parent_id does not exist in knowledge', async () => {
    const { db } = makeMockDb(); // no knowledge rows seeded
    await expect(
      applyProposeNew(db, { mutation: 'propose_new', name: 'x', parent_id: 'ghost-parent' }),
    ).rejects.toThrow(/parent knowledge node not found.*ghost-parent/i);
  });
});

describe('acceptProposal (propose_new only)', () => {
  it('accepts pending propose_new proposal: inserts knowledge + sets status', async () => {
    const proposal = {
      id: 'p1',
      kind: 'knowledge',
      payload: JSON.stringify({
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      }),
      reasoning: 'test',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db, calls } = makeMockDb({
      proposals: { p1: proposal },
      knowledge: { 'seed:wenyan:shici': { id: 'seed:wenyan:shici' } },
    });
    const result = await acceptProposal(db, 'p1');
    expect(result.kind).toBe('propose_new_applied');
    expect(result.new_node_id).toMatch(/^[a-z0-9]+$/);
    expect(calls.some((c) => /insert into knowledge/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /update dreaming_proposal set status = \?/i.test(c.sql))).toBe(true);
  });

  it('rejects accept on non-pending proposal', async () => {
    const proposal = {
      id: 'p2',
      kind: 'knowledge',
      payload: JSON.stringify({ mutation: 'propose_new', name: 'x', parent_id: null }),
      reasoning: 'test',
      status: 'accepted',
      proposed_at: 1700000000,
      decided_at: 1700001000,
    };
    const { db } = makeMockDb({ proposals: { p2: proposal } });
    await expect(acceptProposal(db, 'p2')).rejects.toThrow(/not.*pending/i);
  });

  it('rejects unsupported mutation kinds (PR A scope)', async () => {
    const proposal = {
      id: 'p3',
      kind: 'knowledge',
      payload: JSON.stringify({ mutation: 'reparent', node_id: 'x', new_parent_id: 'y' }),
      reasoning: 'test',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db } = makeMockDb({ proposals: { p3: proposal } });
    await expect(acceptProposal(db, 'p3')).rejects.toThrow(/PR A.*propose_new/i);
  });

  it('rejects accept when parent_id does not exist', async () => {
    const proposal = {
      id: 'p5',
      kind: 'knowledge',
      payload: JSON.stringify({
        mutation: 'propose_new',
        name: 'x',
        parent_id: 'ghost-parent',
      }),
      reasoning: 'test',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db } = makeMockDb({ proposals: { p5: proposal } }); // no knowledge rows
    await expect(acceptProposal(db, 'p5')).rejects.toThrow(
      /parent knowledge node not found.*ghost-parent/i,
    );
  });

  it('throws when concurrent accept already flipped status (UPDATE affects 0 rows)', async () => {
    const proposal = {
      id: 'p6',
      kind: 'knowledge',
      payload: JSON.stringify({
        mutation: 'propose_new',
        name: '通假字',
        parent_id: 'seed:wenyan:shici',
      }),
      reasoning: 'test',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db } = makeMockDb({
      proposals: { p6: proposal },
      knowledge: { 'seed:wenyan:shici': { id: 'seed:wenyan:shici' } },
      raceUpdateZeroChanges: true,
    });
    await expect(acceptProposal(db, 'p6')).rejects.toThrow(/concurrently decided/i);
  });
});

describe('dismissProposal', () => {
  it('updates status to dismissed', async () => {
    const proposal = {
      id: 'p4',
      kind: 'knowledge',
      payload: JSON.stringify({ mutation: 'propose_new', name: 'x', parent_id: null }),
      reasoning: 'test',
      status: 'pending',
      proposed_at: 1700000000,
      decided_at: null,
    };
    const { db, calls } = makeMockDb({ proposals: { p4: proposal } });
    await dismissProposal(db, 'p4');
    const update = calls.find((c) => /update dreaming_proposal/i.test(c.sql));
    expect(update?.binds[0]).toBe('dismissed');
  });
});

import { applyReparent, applyArchive, applySplit, applyMerge } from './proposals';

describe('applyReparent', () => {
  it('moves a child node to a new parent (happy path)', async () => {
    const { db, calls } = makeMockDb({
      knowledge: {
        k_node: { id: 'k_node', parent_id: 'k_oldparent', version: 3, archived_at: null },
        k_newparent: { id: 'k_newparent', archived_at: null },
      },
    });
    await applyReparent(db, {
      mutation: 'reparent',
      node_id: 'k_node',
      new_parent_id: 'k_newparent',
      expected_version: 3,
    });
    const update = calls.find((c) => /update knowledge/i.test(c.sql) && /parent_id/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update?.binds[0]).toBe('k_newparent');
    expect(update?.binds[2]).toBe('k_node');
    expect(update?.binds[3]).toBe(3);
  });

  it('rejects reparent → null (root creation, PR A guard)', async () => {
    const { db } = makeMockDb({});
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
    const { db } = makeMockDb({
      knowledge: {
        k_archived: { id: 'k_archived', archived_at: 1700000000 },
      },
    });
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
    const { db } = makeMockDb({
      knowledge: { k_newparent: { id: 'k_newparent', archived_at: null } },
      runZeroChangesFor: /update knowledge/i,
    });
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
  it('archives a node and bumps version (happy path)', async () => {
    const { db, calls } = makeMockDb({
      knowledge: { k_node: { id: 'k_node', archived_at: null, version: 5 } },
    });
    await applyArchive(db, {
      mutation: 'archive',
      node_id: 'k_node',
      expected_version: 5,
    });
    const update = calls.find((c) => /update knowledge/i.test(c.sql) && /archived_at = \?/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update?.binds[2]).toBe('k_node');
    expect(update?.binds[3]).toBe(5);
  });

  it('throws stale error when already archived (changes=0)', async () => {
    const { db } = makeMockDb({
      knowledge: { k_node: { id: 'k_node', archived_at: 1700000000, version: 5 } },
      runZeroChangesFor: /update knowledge/i,
    });
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
  it('archives from + inserts N new children (happy path)', async () => {
    const { db, calls } = makeMockDb({
      knowledge: {
        k_from: { id: 'k_from', archived_at: null, version: 7 },
        k_p1: { id: 'k_p1', archived_at: null },
        k_p2: { id: 'k_p2', archived_at: null },
      },
    });
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
    const inserts = calls.filter((c) => /insert into knowledge/i.test(c.sql));
    expect(inserts).toHaveLength(2);
    const archive = calls.find((c) => /update knowledge/i.test(c.sql) && /archived_at/i.test(c.sql));
    expect(archive).toBeDefined();
  });

  it('rejects split with into[].parent_id=null (root creation)', async () => {
    const { db } = makeMockDb({
      knowledge: { k_from: { id: 'k_from', archived_at: null, version: 1 } },
    });
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
    const { db } = makeMockDb({
      knowledge: {
        k_from: { id: 'k_from', archived_at: null, version: 7 },
        k_p1: { id: 'k_p1', archived_at: null },
      },
      raceUpdateZeroChanges: true,
    });
    await expect(
      applySplit(db, {
        mutation: 'split',
        from_id: 'k_from',
        into: [{ name: 'A', parent_id: 'k_p1' }],
        expected_version: 7,
      }),
    ).rejects.toThrow(/stale/i);
  });
});

describe('applyMerge', () => {
  it('archives all from_ids + pushes to into.merged_from (happy path)', async () => {
    const { db, calls } = makeMockDb({
      knowledge: {
        k_from1: { id: 'k_from1', archived_at: null, version: 2 },
        k_from2: { id: 'k_from2', archived_at: null, version: 4 },
        k_into: { id: 'k_into', archived_at: null, version: 1, merged_from: '[]' },
      },
    });
    await applyMerge(db, {
      mutation: 'merge',
      from_ids: ['k_from1', 'k_from2'],
      into_id: 'k_into',
      expected_versions: { k_from1: 2, k_from2: 4 },
    });
    const archives = calls.filter(
      (c) => /update knowledge/i.test(c.sql) && /archived_at = \?/i.test(c.sql),
    );
    expect(archives).toHaveLength(2);
    const intoUpdate = calls.find(
      (c) => /update knowledge/i.test(c.sql) && /merged_from/i.test(c.sql),
    );
    expect(intoUpdate).toBeDefined();
  });

  it('rejects when into_id is in from_ids', async () => {
    const { db } = makeMockDb({});
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
    const { db } = makeMockDb({});
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
    const { db } = makeMockDb({
      knowledge: {
        k_from1: { id: 'k_from1', archived_at: null, version: 2 },
        k_into: { id: 'k_into', archived_at: null, version: 1, merged_from: '[]' },
      },
      raceUpdateZeroChanges: true,
    });
    await expect(
      applyMerge(db, {
        mutation: 'merge',
        from_ids: ['k_from1'],
        into_id: 'k_into',
        expected_versions: { k_from1: 2 },
      }),
    ).rejects.toThrow(/stale/i);
  });
});
