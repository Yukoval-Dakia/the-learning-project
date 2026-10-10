// YUK-440 (A13) — kc_typed_state single-writer tests. Pure §修正-4 gate + DB upsert
// (concurrency serialization / deterministic transitions / evidence append-union).

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kc_typed_state } from '@/db/schema';

import { resetDb } from '../../../tests/helpers/db';
import { type UpsertKcTypedStateInput, upsertKcTypedState } from './typed-state';

describe('upsertKcTypedState (single-writer, DB)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function row(subjectId: string) {
    const rows = await db
      .select()
      .from(kc_typed_state)
      .where(
        and(eq(kc_typed_state.subject_kind, 'knowledge'), eq(kc_typed_state.subject_id, subjectId)),
      );
    return rows[0] ?? null;
  }

  it('serializes concurrent updates of the same KC with no lost evidence', async () => {
    const input = (ids: string[]): UpsertKcTypedStateInput => ({
      subject_id: 'k_conc',
      proposed: 'no-evidence',
      discriminating: false,
      recurrence_count: 2,
      evidence_event_ids: ids,
      last_evidence_at: new Date(),
    });
    await Promise.all([
      upsertKcTypedState(db, input(['a'])),
      upsertKcTypedState(db, input(['b'])),
      upsertKcTypedState(db, input(['c'])),
    ]);
    const r = await row('k_conc');
    expect([...(r?.evidence_event_ids ?? [])].sort()).toEqual(['a', 'b', 'c']);
  });
});
