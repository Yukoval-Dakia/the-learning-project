import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import {
  writeDreamingProposal,
  applyProposeNew,
  acceptProposal,
  dismissProposal,
} from './proposals';

function makeMockDb(initialRows: Record<string, Record<string, unknown>> = {}) {
  const tableRows: Record<string, Record<string, Record<string, unknown>>> = {
    knowledge: {},
    dreaming_proposal: { ...initialRows },
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
            return tableRows.knowledge[binds[0] as string] ?? null;
          }
          return null;
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
        all: async () => ({ results: Object.values(tableRows.dreaming_proposal) }),
      };
    },
  }));
  return { db: { prepare } as unknown as D1Database, tableRows, calls };
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
    const { db, calls } = makeMockDb();
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
    const { db, calls } = makeMockDb({ p1: proposal });
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
    const { db } = makeMockDb({ p2: proposal });
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
    const { db } = makeMockDb({ p3: proposal });
    await expect(acceptProposal(db, 'p3')).rejects.toThrow(/PR A.*propose_new/i);
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
    const { db, calls } = makeMockDb({ p4: proposal });
    await dismissProposal(db, 'p4');
    const update = calls.find((c) => /update dreaming_proposal/i.test(c.sql));
    expect(update?.binds[0]).toBe('dismissed');
  });
});
