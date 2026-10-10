// Phase 1c.1 Step 4 — events queries module (ADR-0005 single-owner read API).
//
// Per spec §"New module: src/server/events/queries.ts" — all event reads/writes
// must funnel through this module. Tests seed `event` table directly with
// hand-built KnownEvent-shaped rows; no Step 3 migration in test fixtures.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { deterministicId } from '@/core/ids';
import { event } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { writeEvent, writeEvents } from './index';

describe('writeEvent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('keeps first-write-wins when duplicate ids appear inside one batch', async () => {
    const db = testDb();
    const id = 'evt-batch-duplicate';
    const base = {
      id,
      actor_kind: 'system',
      actor_ref: 'test',
      action: 'experimental:test_batch',
      subject_kind: 'query',
      subject_id: 'batch',
      outcome: 'success',
    } as const;
    await writeEvents(db, [
      { ...base, payload: { ordinal: 1 } },
      { ...base, payload: { ordinal: 2 } },
    ]);

    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ ordinal: 1 });
  });

  it('is idempotent under duplicate id (returns existing id, no second row)', async () => {
    const db = testDb();
    const id = deterministicId('evt_test', 'fixed1');
    const base = {
      id,
      session_id: null,
      actor_kind: 'user' as const,
      actor_ref: 'self',
      action: 'attempt' as const,
      subject_kind: 'question' as const,
      subject_id: 'q1',
      outcome: 'failure' as const,
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date('2026-05-01T00:00:00Z'),
    };
    const id1 = await writeEvent(db, base);
    const id2 = await writeEvent(db, {
      ...base,
      payload: { ...base.payload, answer_md: 'different' },
    });
    expect(id1).toBe(id);
    expect(id2).toBe(id);
    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    // First write wins (no overwrite on conflict)
    const payload = rows[0].payload as { answer_md: string };
    expect(payload.answer_md).toBe('wrong');
  });
});
