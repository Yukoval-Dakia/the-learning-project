// YUK-531 (A5 S4 / ADR-0036 RT1) — misconception_edge single-owner throat tests.

import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/kernel/http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { archiveMisconceptionEdge, createMisconceptionEdge } from './misconception-edges';

const AI = { by: 'ai' as const };

describe('misconception-edges throat', () => {
  beforeEach(async () => {
    await resetDb();
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
