// YUK-531 (A5 S4 / ADR-0036 RT1) — misconception_edge single-owner throat tests.

import { misconception_edge } from '@/db/schema';
import { ApiError } from '@/server/http/errors';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { archiveMisconceptionEdge, createMisconceptionEdge } from './misconception-edges';

const AI = { by: 'ai' as const };

describe('misconception-edges throat', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('createMisconceptionEdge inserts a caused_by edge and returns its id', async () => {
    const db = testDb();
    const id = await createMisconceptionEdge(db, {
      from_id: 'misc_1',
      to_kind: 'knowledge',
      to_id: 'kn_1',
      relation_type: 'caused_by',
      weight: 0.7,
      created_by: AI,
      proposed_by_ai: true,
    });
    const rows = await db.select().from(misconception_edge).where(eq(misconception_edge.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].from_kind).toBe('misconception');
    expect(rows[0].from_id).toBe('misc_1');
    expect(rows[0].to_kind).toBe('knowledge');
    expect(rows[0].to_id).toBe('kn_1');
    expect(rows[0].relation_type).toBe('caused_by');
    expect(rows[0].weight).toBeCloseTo(0.7);
    expect(rows[0].archived_at).toBeNull();
  });

  it('re-create of the same edge UPSERTs (no 23505): same row id, single row', async () => {
    const db = testDb();
    const id1 = await createMisconceptionEdge(db, {
      from_id: 'misc_1',
      to_kind: 'knowledge',
      to_id: 'kn_1',
      relation_type: 'caused_by',
      weight: 0.5,
      created_by: AI,
    });
    const id2 = await createMisconceptionEdge(db, {
      from_id: 'misc_1',
      to_kind: 'knowledge',
      to_id: 'kn_1',
      relation_type: 'caused_by',
      weight: 0.9,
      created_by: AI,
    });
    expect(id2).toBe(id1); // conflict-update keeps the existing row id
    const all = await db.select().from(misconception_edge);
    expect(all).toHaveLength(1);
    expect(all[0].weight).toBeCloseTo(0.9); // weight refreshed
  });

  it('re-create UN-ARCHIVES a previously archived edge (archived_at NULL again)', async () => {
    const db = testDb();
    const id = await createMisconceptionEdge(db, {
      from_id: 'misc_1',
      to_kind: 'knowledge',
      to_id: 'kn_1',
      relation_type: 'caused_by',
      created_by: AI,
    });
    const archived = await archiveMisconceptionEdge(db, id);
    expect(archived).toEqual({ id, archived: true });
    const afterArchive = await db
      .select()
      .from(misconception_edge)
      .where(eq(misconception_edge.id, id));
    expect(afterArchive[0].archived_at).not.toBeNull();

    // Re-propose the same edge → un-archive (idempotent re-promote path).
    const id2 = await createMisconceptionEdge(db, {
      from_id: 'misc_1',
      to_kind: 'knowledge',
      to_id: 'kn_1',
      relation_type: 'caused_by',
      created_by: AI,
    });
    expect(id2).toBe(id);
    const afterReCreate = await db
      .select()
      .from(misconception_edge)
      .where(eq(misconception_edge.id, id));
    expect(afterReCreate[0].archived_at).toBeNull();
  });

  it('topology gate REJECTS caused_by → event (wrong target kind)', async () => {
    const db = testDb();
    await expect(
      createMisconceptionEdge(db, {
        from_id: 'misc_1',
        to_kind: 'event',
        to_id: 'evt_1',
        relation_type: 'caused_by', // caused_by requires to_kind=knowledge
        created_by: AI,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(await db.select().from(misconception_edge)).toHaveLength(0);
  });

  it('canonical-orders symmetric misc↔misc confusable_with (smaller id is from_id)', async () => {
    const db = testDb();
    // Propose B↔A (from=misc_b, to=misc_a) — should store as misc_a → misc_b.
    const id1 = await createMisconceptionEdge(db, {
      from_id: 'misc_b',
      to_kind: 'misconception',
      to_id: 'misc_a',
      relation_type: 'confusable_with',
      created_by: AI,
    });
    const stored = await db.select().from(misconception_edge).where(eq(misconception_edge.id, id1));
    expect(stored[0].from_id).toBe('misc_a');
    expect(stored[0].to_id).toBe('misc_b');

    // Propose the OTHER direction A↔B — collapses onto the same row.
    const id2 = await createMisconceptionEdge(db, {
      from_id: 'misc_a',
      to_kind: 'misconception',
      to_id: 'misc_b',
      relation_type: 'confusable_with',
      created_by: AI,
    });
    expect(id2).toBe(id1);
    expect(await db.select().from(misconception_edge)).toHaveLength(1);
  });

  it('rejects an out-of-range weight (Zod 0-1 guard, before the DB CHECK)', async () => {
    const db = testDb();
    await expect(
      createMisconceptionEdge(db, {
        from_id: 'misc_1',
        to_kind: 'knowledge',
        to_id: 'kn_1',
        relation_type: 'caused_by',
        weight: 1.5,
        created_by: AI,
      }),
    ).rejects.toThrow();
    expect(await db.select().from(misconception_edge)).toHaveLength(0);
  });

  it('archiveMisconceptionEdge is idempotent and 404s on a missing id', async () => {
    const db = testDb();
    const id = await createMisconceptionEdge(db, {
      from_id: 'misc_1',
      to_kind: 'knowledge',
      to_id: 'kn_1',
      relation_type: 'caused_by',
      created_by: AI,
    });
    expect(await archiveMisconceptionEdge(db, id)).toEqual({ id, archived: true });
    // Second archive is a no-op.
    expect(await archiveMisconceptionEdge(db, id)).toEqual({ id, archived: false });
    // Unknown id → 404.
    await expect(archiveMisconceptionEdge(db, 'nope')).rejects.toBeInstanceOf(ApiError);
  });
});
