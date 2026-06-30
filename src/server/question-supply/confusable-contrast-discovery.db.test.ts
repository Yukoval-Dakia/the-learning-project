// YUK-533 (ADR-0036 RT1 consumer) — confusable-contrast discovery DB test (real Postgres).
// hermetic 契约：每个 db 测在 beforeEach resetDb()。Covers: flag-OFF NO-OP; flag-ON emits one
// quiz_gen-routed contrast target per confusable KC pair with the right shape.

import { db } from '@/db/client';
import { knowledge, misconception_edge } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import { discoverConfusableContrastTargets } from './confusable-contrast-discovery';

async function seedKnowledge(id: string, domain = 'wenyan') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedEdge(opts: {
  fromId: string;
  toKind: 'misconception' | 'knowledge' | 'event';
  toId: string;
  relationType: string;
  weight?: number;
}): Promise<void> {
  const now = new Date();
  await db.insert(misconception_edge).values({
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
    archived_at: null,
  });
}

// M1 caused_by A, M2 caused_by B, M1 confusable_with M2 → confusable pair [A,B].
async function seedConfusablePair(a: string, b: string, weight = 0.8) {
  await seedKnowledge(a);
  await seedKnowledge(b);
  await seedEdge({ fromId: 'mc_a', toKind: 'knowledge', toId: a, relationType: 'caused_by' });
  await seedEdge({ fromId: 'mc_b', toKind: 'knowledge', toId: b, relationType: 'caused_by' });
  await seedEdge({
    fromId: 'mc_a',
    toKind: 'misconception',
    toId: 'mc_b',
    relationType: 'confusable_with',
    weight,
  });
}

describe('discoverConfusableContrastTargets (YUK-533)', () => {
  const prev = process.env.CONFUSABLE_CONTRAST_ENABLED;
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    if (prev === undefined) delete process.env.CONFUSABLE_CONTRAST_ENABLED;
    else process.env.CONFUSABLE_CONTRAST_ENABLED = prev;
  });

  it('flag OFF → NO-OP even with a confusable pair present', async () => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.CONFUSABLE_CONTRAST_ENABLED;
    await seedConfusablePair('kc_a', 'kc_b');

    const targets = await discoverConfusableContrastTargets(db);
    expect(targets).toEqual([]);
  });

  it('flag ON → emits one quiz_gen-routed contrast target for the confusable pair', async () => {
    process.env.CONFUSABLE_CONTRAST_ENABLED = '1';
    await seedConfusablePair('kc_a', 'kc_b');

    const targets = await discoverConfusableContrastTargets(db);
    expect(targets).toHaveLength(1);
    const t = targets[0];
    expect(t.gapKind).toBe('confusable_contrast');
    expect(t.knowledgeIds).toEqual(['kc_a', 'kc_b']); // canonical sorted pair
    expect(t.kind).toBe('choice');
    expect(t.subjectId).toBe('wenyan');
    expect(t.minSourceTier).toBe(3);
    expect(t.routePreference).toEqual(['quiz_gen']);
    expect(t.desiredCount).toBe(1);
    // No objectiveOnly constraint (would divert the route planner off quiz_gen).
    expect(t.constraints.objectiveOnly).toBeUndefined();
    // Priority is the fixed gap base demand (edge confidence band never feeds it).
    expect(t.priority).toBeCloseTo(0.6, 5);
    // The qualitative band tags the reason; raw weight never appears.
    expect(t.reason).toContain('conf=');
    expect(JSON.stringify(t)).not.toContain('0.8');
  });

  it('flag ON but empty mesh → []', async () => {
    process.env.CONFUSABLE_CONTRAST_ENABLED = '1';
    const targets = await discoverConfusableContrastTargets(db);
    expect(targets).toEqual([]);
  });
});
