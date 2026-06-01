// Station 2A (YUK-185, T-37) — end-to-end DB test of the prod brief-writer path
// with a STUBBED runTaskFn (no live LLM).
//
// Drives regenerateMemoryBrief with `generate: buildBriefGenerator({ db, runTaskFn })`
// where the stub returns a canned BriefDraft JSON citing real seeded event ids.
// Asserts: a memory_brief_note row is written, executeMemoryBrief
// (query_memory_brief) returns non-null, and the P5.3 long_term_freshness_score
// computes (non-null) when long_term_evidence_ids resolve to seeded events —
// plus the null path when the cited ids do not resolve. The stub also throws on
// any kind !== 'MemoryBriefTask' (no-live-LLM guard, Pattern C). DB-touching →
// db partition.

import { event, memory_brief_note } from '@/db/schema';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { executeMemoryBrief } from '@/server/ai/tools/context-readers';
import type { ToolContext } from '@/server/ai/tools/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { regenerateMemoryBrief } from './brief';
import { buildBriefGenerator } from './brief-writer';

const NOW = new Date('2026-06-01T03:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function insertEvent(id: string, createdAt: Date): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: `q-${id}`,
      outcome: 'failure',
      payload: { answer_md: 'wrong attempt', answer_image_refs: [], referenced_knowledge_ids: [] },
      affected_scopes: ['global'],
      created_at: createdAt,
    });
}

// Canned BriefDraft JSON — what the stubbed MemoryBriefTask run "returns".
function cannedDraft(longTermIds: string[]): string {
  return JSON.stringify({
    recent_week_md: '## Recent week\n- attempted a few questions',
    recent_months_md: '## Recent months\n- working through the basics',
    long_term_md: '## Long term\n- recurring weak spot on tense aspect',
    recent_week_evidence_ids: longTermIds.slice(0, 1),
    recent_months_evidence_ids: [],
    long_term_evidence_ids: longTermIds,
  });
}

// Pattern C — no-live-LLM guard. Throws on any non-MemoryBriefTask kind, AND
// asserts the writer threaded the 3A `now` ISO field into the input.
function makeStub(longTermIds: string[]): TaskTextRunFn {
  return vi.fn(async (kind, input) => {
    if (kind !== 'MemoryBriefTask') {
      throw new Error(`no-live-LLM guard: unexpected task kind ${kind}`);
    }
    expect(typeof (input as { now?: unknown }).now).toBe('string');
    return { text: cannedDraft(longTermIds), cost_usd: 0 };
  });
}

function toolCtx(): ToolContext {
  return { db: testDb(), taskRunId: 'test-run', callerActor: { kind: 'system', ref: 'test' } };
}

describe('brief-writer end-to-end through regenerateMemoryBrief (DB, stubbed LLM)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a memory_brief_note row, query_memory_brief returns it, and freshness computes', async () => {
    const e1 = 'evt_bw_1';
    const e2 = 'evt_bw_2';
    await insertEvent(e1, daysAgo(1));
    await insertEvent(e2, daysAgo(40));

    const stub = makeStub([e1, e2]);

    const { wrote, row } = await regenerateMemoryBrief({
      db: testDb(),
      scopeKey: 'global',
      searchFacts: async () => [],
      generate: buildBriefGenerator({ db: testDb(), runTaskFn: stub }),
      now: () => NOW,
    });

    expect(wrote).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);
    // 3 windows match the stub.
    expect(row.recent_week_md).toContain('Recent week');
    expect(row.long_term_md).toContain('recurring weak spot');
    expect(row.long_term_evidence_ids).toEqual([e1, e2]);
    // P5.3 — long_term_freshness_score is a number in (0,1] (resolved from real ids).
    expect(row.long_term_freshness_score).not.toBeNull();
    expect(row.long_term_freshness_score as number).toBeGreaterThan(0);
    expect(row.long_term_freshness_score as number).toBeLessThanOrEqual(1);

    // The row is persisted and visible through the read tool (slot lights up).
    const out = await executeMemoryBrief(toolCtx(), { scopeKey: 'global', includeEvidence: true });
    expect(out.note).not.toBeNull();
    expect(out.note?.recent_week_md).toContain('Recent week');
    expect(out.note?.long_term_md).toContain('recurring weak spot');
    expect(out.note?.long_term_freshness_score).not.toBeNull();
    expect(out.evidence?.long_term_ids).toEqual([e1, e2]);
  });

  it('freshness is null when cited long-term ids do not resolve (D3 filter drops them)', async () => {
    const real = 'evt_bw_real';
    await insertEvent(real, daysAgo(2));

    // Stub cites ONLY ids that are not seeded → the writer's D3 filter drops them
    // → long_term_evidence_ids is empty → score is null (unjudgeable).
    const stub = makeStub(['ghost_a', 'ghost_b']);

    const { row } = await regenerateMemoryBrief({
      db: testDb(),
      scopeKey: 'global',
      // Load only the real event so the cited ghosts have nothing to match.
      loadEvents: async () => [
        {
          id: real,
          action: 'attempt',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'failure',
          payload: {},
          created_at: daysAgo(2),
        },
      ],
      searchFacts: async () => [],
      generate: buildBriefGenerator({ db: testDb(), runTaskFn: stub }),
      now: () => NOW,
    });

    expect(row.long_term_evidence_ids).toEqual([]); // ghosts filtered out
    expect(row.long_term_freshness_score).toBeNull();

    const [persisted] = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'global'));
    expect(persisted.long_term_freshness_score).toBeNull();
  });

  it('cold global scope (0 events) writes an all-empty row WITHOUT calling the LLM (4A)', async () => {
    const stub = makeStub([]);

    const { row } = await regenerateMemoryBrief({
      db: testDb(),
      scopeKey: 'global',
      loadEvents: async () => [],
      searchFacts: async () => [],
      generate: buildBriefGenerator({ db: testDb(), runTaskFn: stub }),
      now: () => NOW,
    });

    expect(stub).not.toHaveBeenCalled(); // 4A — no paid call on a cold scope
    expect(row.recent_week_md).toBe('');
    expect(row.long_term_freshness_score).toBeNull();

    const out = await executeMemoryBrief(toolCtx(), { scopeKey: 'global' });
    expect(out.note).not.toBeNull();
    expect(out.note?.recent_week_md).toBe('');
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
