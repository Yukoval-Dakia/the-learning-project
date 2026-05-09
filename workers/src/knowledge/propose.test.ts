import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { parseProposeOutput, runProposeAndWrite } from './propose';

describe('parseProposeOutput', () => {
  it('parses well-formed JSON with proposals array', () => {
    const text = '{"proposals":[{"name":"之-主谓间用法","parent_id":"k_xuci","reasoning":"该错题表明..."}]}';
    const out = parseProposeOutput(text);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].name).toBe('之-主谓间用法');
    expect(out.proposals[0].parent_id).toBe('k_xuci');
  });

  it('extracts JSON from text with surrounding prose', () => {
    const text = '好的，我建议如下：\n\n{"proposals":[{"name":"X","parent_id":"k1","reasoning":"r"}]}\n\n以上。';
    const out = parseProposeOutput(text);
    expect(out.proposals).toHaveLength(1);
  });

  it('returns empty proposals when LLM returns 0 entries', () => {
    const text = '{"proposals":[]}';
    const out = parseProposeOutput(text);
    expect(out.proposals).toHaveLength(0);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseProposeOutput('完全不是 JSON')).toThrow();
  });

  it('throws on JSON missing proposals array', () => {
    expect(() => parseProposeOutput('{"foo":"bar"}')).toThrow();
  });

  it('throws when proposals exceeds 3 entries', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      name: `n${i}`,
      parent_id: 'p',
      reasoning: 'r',
    }));
    const text = JSON.stringify({ proposals: items });
    expect(() => parseProposeOutput(text)).toThrow();
  });

  it('throws when an entry has empty name or reasoning', () => {
    const text = '{"proposals":[{"name":"","parent_id":"p","reasoning":"r"}]}';
    expect(() => parseProposeOutput(text)).toThrow();
  });
});

function makePropoeMockDb(opts: {
  tree: Array<{ id: string; name: string; domain: string | null; parent_id: string | null; archived_at: number | null }>;
}) {
  const inserted: Array<{ payload: string; reasoning: string }> = [];
  const knowledgeById = new Map(opts.tree.map((r) => [r.id, r]));
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => ({
      first: async () => {
        if (/select id from knowledge where id = \? and archived_at is null/i.test(sql)) {
          const id = binds[0] as string;
          const row = knowledgeById.get(id);
          return row && row.archived_at === null ? { id } : null;
        }
        return null;
      },
      all: async () => ({ results: opts.tree }),
      run: async () => {
        if (/insert into dreaming_proposal/i.test(sql)) {
          inserted.push({ payload: binds[2] as string, reasoning: binds[3] as string });
        }
        return { success: true, meta: { changes: 1 } };
      },
    }),
  }));
  const db = { prepare } as unknown as D1Database;
  return { db, inserted };
}

describe('runProposeAndWrite', () => {
  it('writes one dreaming_proposal per parsed propose_new entry', async () => {
    const { db, inserted } = makePropoeMockDb({
      tree: [{ id: 'k_xuci', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    const fakeRunTask = async () => ({
      task_run_id: 't1',
      text: '{"proposals":[{"name":"之-主谓","parent_id":"k_xuci","reasoning":"r1"},{"name":"乎","parent_id":"k_xuci","reasoning":"r2"}]}',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await runProposeAndWrite({
      db,
      mistakeContent: { prompt_md: 'p', reference_md: null, wrong_answer_md: 'w', knowledge_ids_picked: ['k_xuci'] },
      runTaskFn: fakeRunTask,
    });
    expect(inserted).toHaveLength(2);
    expect(JSON.parse(inserted[0].payload)).toMatchObject({ mutation: 'propose_new', name: '之-主谓', parent_id: 'k_xuci' });
  });

  it('skips entries whose parent_id does not exist', async () => {
    const { db, inserted } = makePropoeMockDb({
      tree: [{ id: 'k_xuci', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    const fakeRunTask = async () => ({
      task_run_id: 't',
      text: '{"proposals":[{"name":"X","parent_id":"k_xuci","reasoning":"r"},{"name":"Y","parent_id":"k_does_not_exist","reasoning":"r"}]}',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await runProposeAndWrite({
      db,
      mistakeContent: { prompt_md: 'p', reference_md: null, wrong_answer_md: 'w', knowledge_ids_picked: [] },
      runTaskFn: fakeRunTask,
    });
    expect(inserted).toHaveLength(1);
    expect(JSON.parse(inserted[0].payload).name).toBe('X');
  });

  it('swallows runTask error (no inserts; no throw)', async () => {
    const { db, inserted } = makePropoeMockDb({ tree: [] });
    const fakeRunTask = async () => {
      throw new Error('LLM down');
    };
    await expect(
      runProposeAndWrite({
        db,
        mistakeContent: { prompt_md: 'p', reference_md: null, wrong_answer_md: 'w', knowledge_ids_picked: [] },
        runTaskFn: fakeRunTask,
      }),
    ).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });

  it('swallows parseProposeOutput error (no inserts; no throw)', async () => {
    const { db, inserted } = makePropoeMockDb({ tree: [] });
    const fakeRunTask = async () => ({
      task_run_id: 't',
      text: '不是 JSON',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await expect(
      runProposeAndWrite({
        db,
        mistakeContent: { prompt_md: 'p', reference_md: null, wrong_answer_md: 'w', knowledge_ids_picked: [] },
        runTaskFn: fakeRunTask,
      }),
    ).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });
});
