import { dreaming_proposal, knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { parseProposeOutput, runProposeAndWrite } from './propose';

describe('parseProposeOutput', () => {
  it('parses well-formed JSON with proposals array', () => {
    const text =
      '{"proposals":[{"name":"之-主谓间用法","parent_id":"k_xuci","reasoning":"该错题表明..."}]}';
    const out = parseProposeOutput(text);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0].name).toBe('之-主谓间用法');
    expect(out.proposals[0].parent_id).toBe('k_xuci');
  });

  it('extracts JSON from text with surrounding prose', () => {
    const text =
      '好的，我建议如下：\n\n{"proposals":[{"name":"X","parent_id":"k1","reasoning":"r"}]}\n\n以上。';
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

describe('runProposeAndWrite', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function insertKnowledge(id: string, opts: { archived?: boolean } = {}) {
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
      archived_at: opts.archived ? now : null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }

  it('writes one dreaming_proposal per parsed propose_new entry', async () => {
    const db = testDb();
    await insertKnowledge('k_xuci');
    const fakeRunTask = async () => ({
      text: '{"proposals":[{"name":"之-主谓","parent_id":"k_xuci","reasoning":"r1"},{"name":"乎","parent_id":"k_xuci","reasoning":"r2"}]}',
    });
    await runProposeAndWrite({
      db,
      mistakeContent: {
        prompt_md: 'p',
        reference_md: null,
        wrong_answer_md: 'w',
        knowledge_ids_picked: ['k_xuci'],
      },
      runTaskFn: fakeRunTask,
    });
    const proposals = await db.select().from(dreaming_proposal);
    expect(proposals).toHaveLength(2);
    expect(proposals[0].payload).toMatchObject({
      mutation: 'propose_new',
      name: '之-主谓',
      parent_id: 'k_xuci',
    });
  });

  it('skips entries whose parent_id does not exist', async () => {
    const db = testDb();
    await insertKnowledge('k_xuci');
    const fakeRunTask = async () => ({
      text: '{"proposals":[{"name":"X","parent_id":"k_xuci","reasoning":"r"},{"name":"Y","parent_id":"k_does_not_exist","reasoning":"r"}]}',
    });
    await runProposeAndWrite({
      db,
      mistakeContent: {
        prompt_md: 'p',
        reference_md: null,
        wrong_answer_md: 'w',
        knowledge_ids_picked: [],
      },
      runTaskFn: fakeRunTask,
    });
    const proposals = await db.select().from(dreaming_proposal);
    expect(proposals).toHaveLength(1);
    expect((proposals[0].payload as Record<string, unknown>).name).toBe('X');
  });

  it('swallows runTask error (no inserts; no throw)', async () => {
    const db = testDb();
    const fakeRunTask = async () => {
      throw new Error('LLM down');
    };
    await expect(
      runProposeAndWrite({
        db,
        mistakeContent: {
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids_picked: [],
        },
        runTaskFn: fakeRunTask,
      }),
    ).resolves.toBeUndefined();
    const proposals = await db.select().from(dreaming_proposal);
    expect(proposals).toHaveLength(0);
  });

  it('swallows parseProposeOutput error (no inserts; no throw)', async () => {
    const db = testDb();
    const fakeRunTask = async () => ({
      text: '不是 JSON',
    });
    await expect(
      runProposeAndWrite({
        db,
        mistakeContent: {
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids_picked: [],
        },
        runTaskFn: fakeRunTask,
      }),
    ).resolves.toBeUndefined();
    const proposals = await db.select().from(dreaming_proposal);
    expect(proposals).toHaveLength(0);
  });
});
