// P5.3 (YUK-183) — long-term brief freshness score, DB partition.
//
// Exercises regenerateMemoryBrief end-to-end against real Postgres: the score
// must round-trip through the new memory_brief_note.long_term_freshness_score
// `real` column, AND the long_term_md / long_term_evidence_ids from the injected
// `generate` draft must NOT be mutated/blanked (the §2.2 critical reframe). The
// `generate` default throws, so a fake is injected. Because no `loadEventTimestamps`
// override is supplied, the missing long-term id is resolved by the REAL batched
// `resolveEvidenceTimestamps` inArray(event.id, …) query against Postgres (§4.3),
// which is the data-flow path unit tests can't cover. DB-touching → db partition.

import { event, memory_brief_note } from '@/db/schema';
import { LONG_TERM_FRESHNESS_BUDGET } from '@/server/ai/tools/budgets';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { type GenerateBrief, regenerateMemoryBrief } from './brief';

const NOW = new Date('2026-05-31T03:00:00Z');
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
      payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [] },
      affected_scopes: ['global', 'topic:k-x'],
      created_at: createdAt,
    });
}

describe('regenerateMemoryBrief — P5.3 score persistence (DB)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('persists long_term_freshness_score end-to-end and does NOT mutate long_term_md', async () => {
    // An OLD long-term evidence event lives in the DB but is NOT in the loaded
    // window → resolved via the REAL batched inArray query (no loader injected).
    const oldId = 'evt_old_lt';
    await insertEvent(oldId, daysAgo(200));

    const draft = {
      recent_week_md: '## Recent week\n- fresh',
      recent_months_md: '## Recent months\n- fresh',
      long_term_md: '## Long term\n- Responds well to contrastive examples.',
      recent_week_evidence_ids: ['evt_recent'],
      recent_months_evidence_ids: ['evt_recent'],
      long_term_evidence_ids: [oldId],
    };
    const generate = vi.fn<GenerateBrief>(async () => draft);

    const { row } = await regenerateMemoryBrief({
      db: testDb(),
      scopeKey: 'global',
      // Loaded window holds only a RECENT event — the cited old long-term id is
      // absent here, forcing the batched DB timestamp lookup.
      loadEvents: async () => [
        {
          id: 'evt_recent',
          action: 'attempt',
          subject_kind: 'question',
          subject_id: 'q1',
          outcome: 'success',
          payload: {},
          created_at: daysAgo(0),
        },
      ],
      searchFacts: async () => [],
      generate,
      now: () => NOW,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    // 200d-old single evidence with 60d half-life ⇒ well under the 0.3 boundary.
    expect(row.long_term_freshness_score).not.toBeNull();
    expect(row.long_term_freshness_score as number).toBeLessThan(
      LONG_TERM_FRESHNESS_BUDGET.freshnessThreshold,
    );

    // Round-trip: re-read from Postgres and confirm the `real` column persisted.
    const [persisted] = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'global'));
    expect(persisted).toBeDefined();
    expect(persisted.long_term_freshness_score).not.toBeNull();
    expect(persisted.long_term_freshness_score as number).toBeCloseTo(
      row.long_term_freshness_score as number,
      4,
    );
    // Critical reframe: the paragraph + evidence ids are UNMUTATED.
    expect(persisted.long_term_md).toBe(draft.long_term_md);
    expect(persisted.long_term_evidence_ids).toEqual(draft.long_term_evidence_ids);
  });

  it('writes null score for an empty long-term window (unjudgeable) and re-update keeps md intact', async () => {
    const draft = {
      recent_week_md: '## week',
      recent_months_md: '## months',
      long_term_md: '## Long term\n- stable preference.',
      recent_week_evidence_ids: [],
      recent_months_evidence_ids: [],
      long_term_evidence_ids: [],
    };
    const generate = vi.fn<GenerateBrief>(async () => draft);

    // INSERT path.
    await regenerateMemoryBrief({
      db: testDb(),
      scopeKey: 'global',
      loadEvents: async () => [],
      searchFacts: async () => [],
      generate,
      now: () => NOW,
    });
    // UPDATE path (onConflictDoUpdate) — proves the .set() write path persists too.
    await regenerateMemoryBrief({
      db: testDb(),
      scopeKey: 'global',
      loadEvents: async () => [],
      searchFacts: async () => [],
      generate,
      now: () => NOW,
    });

    const [persisted] = await testDb()
      .select()
      .from(memory_brief_note)
      .where(eq(memory_brief_note.scope_key, 'global'));
    expect(persisted.long_term_freshness_score).toBeNull();
    expect(persisted.long_term_md).toBe(draft.long_term_md);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
