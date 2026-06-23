// YUK-471 W1 PR-A2a — DB tests for the materialized_id_index helpers (testcontainer).
// Hermetic contract: resetDb() in beforeEach; no cross-file/order assumptions.

import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, testDb } from '../../../tests/helpers/db';
import { getAnchorEventId, upsertMaterializedIdIndex } from './materialized-id-index';

describe('materialized_id_index helpers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('upsert then read-back returns the anchor event id', async () => {
    const db = testDb();
    await upsertMaterializedIdIndex(db, {
      materialized_id: 'kn_node_a',
      anchor_event_id: 'ev_propose_1',
      subject_kind: 'knowledge',
    });

    const anchor = await getAnchorEventId(db, 'kn_node_a');
    expect(anchor).toBe('ev_propose_1');
  });

  it('returns null for an id that was never indexed', async () => {
    const db = testDb();
    const anchor = await getAnchorEventId(db, 'kn_missing');
    expect(anchor).toBeNull();
  });

  it('round-trips a knowledge_edge subject_kind anchor', async () => {
    const db = testDb();
    await upsertMaterializedIdIndex(db, {
      materialized_id: 'ke_edge_x',
      anchor_event_id: 'ev_edge_genesis_1',
      subject_kind: 'knowledge_edge',
    });

    expect(await getAnchorEventId(db, 'ke_edge_x')).toBe('ev_edge_genesis_1');
  });

  it('onConflictDoNothing is idempotent — first write wins, a second upsert with a different anchor does NOT overwrite', async () => {
    const db = testDb();
    await upsertMaterializedIdIndex(db, {
      materialized_id: 'kn_node_b',
      anchor_event_id: 'ev_first',
      subject_kind: 'knowledge',
    });

    // Second upsert for the SAME materialized id (the id is minted exactly once) carrying a
    // different anchor must be a no-op, not an overwrite or a unique-violation error.
    await upsertMaterializedIdIndex(db, {
      materialized_id: 'kn_node_b',
      anchor_event_id: 'ev_second',
      subject_kind: 'knowledge',
    });

    // First write wins — the original anchor (the id's true origin event) survives.
    expect(await getAnchorEventId(db, 'kn_node_b')).toBe('ev_first');
  });
});
