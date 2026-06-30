// YUK-533 (ADR-0036 RT1 consumer) — confusable_with read model DB test.
// Hits @/db/client → db partition. Covers: misc↔misc + misc↔knowledge endpoint
// resolution (via caused_by); symmetric A↔B dedup (no double-count); archived edge
// filtering; the conf band; strongest-band-wins on duplicate pairs; honest empty;
// the ⑥ conf-strip invariant (no raw weight/confidence keys nor seeded numbers on the wire).

import { misconception_edge } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadConfusablePairs } from './misconception-confusable-read';

// Raw misconception_edge insert (endpoints are loose text-refs, no FK — no node rows needed).
async function seedEdge(opts: {
  fromId: string;
  toKind: 'misconception' | 'knowledge' | 'event';
  toId: string;
  relationType: string;
  weight?: number;
  archived?: boolean;
}): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(misconception_edge)
    .values({
      id: createId(),
      from_kind: 'misconception',
      from_id: opts.fromId,
      to_kind: opts.toKind,
      to_id: opts.toId,
      relation_type: opts.relationType,
      weight: opts.weight ?? 1,
      created_by: { by: 'system' },
      proposed_by_ai: true,
      created_at: now,
      updated_at: now,
      archived_at: opts.archived ? now : null,
    });
}

describe('loadConfusablePairs (YUK-533)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('resolves a misc↔misc confusable edge to a canonical KC pair', async () => {
    // M1 caused_by KC_A, M2 caused_by KC_B, M1 confusable_with M2.
    await seedEdge({ fromId: 'm1', toKind: 'knowledge', toId: 'kc_a', relationType: 'caused_by' });
    await seedEdge({ fromId: 'm2', toKind: 'knowledge', toId: 'kc_b', relationType: 'caused_by' });
    await seedEdge({
      fromId: 'm1',
      toKind: 'misconception',
      toId: 'm2',
      relationType: 'confusable_with',
      weight: 0.8,
    });

    const pairs = await loadConfusablePairs(testDb());
    expect(pairs).toHaveLength(1);
    expect(pairs[0].knowledgeIds).toEqual(['kc_a', 'kc_b']); // canonical sorted
    expect(pairs[0].pairKey).toBe('kc_a|kc_b');
    expect(pairs[0].conf).toBe('高'); // weight 0.8 ≥ 0.67
  });

  it('resolves a misc↔knowledge confusable edge (knowledge endpoint used directly)', async () => {
    // M1 caused_by KC_A, M1 confusable_with KC_C (to_kind=knowledge).
    await seedEdge({ fromId: 'm1', toKind: 'knowledge', toId: 'kc_a', relationType: 'caused_by' });
    await seedEdge({
      fromId: 'm1',
      toKind: 'knowledge',
      toId: 'kc_c',
      relationType: 'confusable_with',
      weight: 0.2,
    });

    const pairs = await loadConfusablePairs(testDb());
    expect(pairs).toHaveLength(1);
    expect(pairs[0].knowledgeIds).toEqual(['kc_a', 'kc_c']);
    expect(pairs[0].conf).toBe('低'); // weight 0.2 < 0.34
  });

  it('does NOT double-count a symmetric A↔B pair when both directions exist', async () => {
    // Defense: even if a non-canonical reverse edge sneaks in (raw insert bypassing the
    // canonical-ordering write throat), the reader collapses A↔B and B↔A to ONE pair.
    await seedEdge({ fromId: 'm1', toKind: 'knowledge', toId: 'kc_a', relationType: 'caused_by' });
    await seedEdge({ fromId: 'm2', toKind: 'knowledge', toId: 'kc_b', relationType: 'caused_by' });
    await seedEdge({
      fromId: 'm1',
      toKind: 'misconception',
      toId: 'm2',
      relationType: 'confusable_with',
      weight: 0.5,
    });
    await seedEdge({
      fromId: 'm2',
      toKind: 'misconception',
      toId: 'm1',
      relationType: 'confusable_with',
      weight: 0.9, // stronger → strongest-band-wins picks this
    });

    const pairs = await loadConfusablePairs(testDb());
    expect(pairs).toHaveLength(1);
    expect(pairs[0].knowledgeIds).toEqual(['kc_a', 'kc_b']);
    expect(pairs[0].conf).toBe('高'); // strongest band (weight 0.9) wins on dedup
  });

  it('filters out archived confusable edges and unresolvable (archived caused_by) endpoints', async () => {
    // Archived confusable edge → dropped entirely.
    await seedEdge({ fromId: 'm1', toKind: 'knowledge', toId: 'kc_a', relationType: 'caused_by' });
    await seedEdge({
      fromId: 'm1',
      toKind: 'knowledge',
      toId: 'kc_z',
      relationType: 'confusable_with',
      archived: true,
    });
    // Live confusable edge but the misc endpoint's caused_by is archived → no KC resolves → no pair.
    await seedEdge({
      fromId: 'm3',
      toKind: 'knowledge',
      toId: 'kc_y',
      relationType: 'caused_by',
      archived: true,
    });
    await seedEdge({
      fromId: 'm3',
      toKind: 'knowledge',
      toId: 'kc_q',
      relationType: 'confusable_with',
    });

    const pairs = await loadConfusablePairs(testDb());
    // m1's confusable edge is archived; m3's left endpoint never resolves → both yield nothing.
    expect(pairs).toEqual([]);
  });

  it('returns [] for an empty mesh (honest empty, never zero-fill)', async () => {
    const pairs = await loadConfusablePairs(testDb());
    expect(pairs).toEqual([]);
  });

  it('never leaks raw confidence/weight numbers on the wire (⑥ anti-guilt, defense in depth)', async () => {
    // Edge weight 0.73 — neither the key nor the raw number may serialize.
    await seedEdge({
      fromId: 'm1',
      toKind: 'knowledge',
      toId: 'kc_strip_a',
      relationType: 'caused_by',
    });
    await seedEdge({
      fromId: 'm1',
      toKind: 'knowledge',
      toId: 'kc_strip_b',
      relationType: 'confusable_with',
      weight: 0.73,
    });

    const pairs = await loadConfusablePairs(testDb());
    expect(pairs).toHaveLength(1);
    expect(pairs[0].conf).toBe('高'); // 0.73 ≥ 0.67

    const json = JSON.stringify({ pairs });
    expect(json).not.toContain('"weight"');
    expect(json).not.toContain('"confidence"');
    expect(json).not.toContain('"predicted_p"');
    expect(json).not.toContain('0.73');
    for (const p of pairs) {
      expect('weight' in p).toBe(false);
      expect('confidence' in p).toBe(false);
    }
  });
});
