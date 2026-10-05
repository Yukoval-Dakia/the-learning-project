// YUK-1015 (454-A) — bounded misconception reader for the attribution retrieve
// stage (design §L1: 候选 = 词表 ∪ 已晋升误区节点). Covers the caused_by-edge
// join surface: active-only, edge/misconception archived filtering, non-caused_by
// exclusion, cross-KC dedup, seen-desc ordering, and honest-empty (no miscs → []
// — the day-one shape while MISCONCEPTION_PROMOTE_ENABLED stays off).

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { misconception, misconception_edge } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getMisconceptionsByIds, listActiveMisconceptionsForKcs } from './failure-learning-context';

async function seedMisc(opts: {
  id: string;
  kcId: string;
  title: string;
  reasoning?: string | null;
  status?: string;
  seen?: number;
  miscArchived?: boolean;
  edgeArchived?: boolean;
  edgeRelationType?: string;
  edgeToId?: string;
}): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(misconception)
    .values({
      id: opts.id,
      title: opts.title,
      reasoning: opts.reasoning ?? null,
      weight: 1,
      status: opts.status ?? 'active',
      source: 'soft',
      seen: opts.seen ?? 0,
      evidence: [],
      created_by: { by: 'system' },
      proposed_by_ai: true,
      created_at: now,
      updated_at: now,
      archived_at: opts.miscArchived ? now : null,
    });
  await testDb()
    .insert(misconception_edge)
    .values({
      id: createId(),
      from_kind: 'misconception',
      from_id: opts.id,
      to_kind: 'knowledge',
      to_id: opts.edgeToId ?? opts.kcId,
      relation_type: opts.edgeRelationType ?? 'caused_by',
      weight: 1,
      created_by: { by: 'system' },
      proposed_by_ai: true,
      created_at: now,
      updated_at: now,
      archived_at: opts.edgeArchived ? now : null,
    });
}

describe('listActiveMisconceptionsForKcs', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns an active misconception caused_by-edged to a queried KC', async () => {
    const db = testDb();
    await seedMisc({
      id: 'misc_aaa111',
      kcId: 'k_xuci',
      title: '「之」作助词的整体性误判',
      reasoning: '三次把主谓间「之」按普通助词处理',
      seen: 3,
    });
    const rows = await listActiveMisconceptionsForKcs(db, ['k_xuci']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'misc_aaa111',
      title: '「之」作助词的整体性误判',
      reasoning: '三次把主谓间「之」按普通助词处理',
      seen: 3,
    });
  });

  it('deduplicates a misconception edged to MULTIPLE queried KCs', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_dup1', kcId: 'k_a', title: 'm1' });
    // Second caused_by edge from the SAME misconception to another queried KC.
    const now = new Date();
    await db.insert(misconception_edge).values({
      id: createId(),
      from_kind: 'misconception',
      from_id: 'misc_dup1',
      to_kind: 'knowledge',
      to_id: 'k_b',
      relation_type: 'caused_by',
      weight: 1,
      created_by: { by: 'system' },
      proposed_by_ai: true,
      created_at: now,
      updated_at: now,
      archived_at: null,
    });
    const rows = await listActiveMisconceptionsForKcs(db, ['k_a', 'k_b']);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('misc_dup1');
  });

  it('excludes draft / archived misconceptions and archived / non-caused_by edges', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_draft', kcId: 'k_a', title: 'draft', status: 'draft' });
    await seedMisc({ id: 'misc_arch', kcId: 'k_a', title: 'archived', miscArchived: true });
    await seedMisc({ id: 'misc_edge_arch', kcId: 'k_a', title: 'edge-arch', edgeArchived: true });
    await seedMisc({
      id: 'misc_confusable',
      kcId: 'k_a',
      title: 'confusable',
      edgeRelationType: 'confusable_with',
    });
    // Live caused_by row — the only survivor.
    await seedMisc({ id: 'misc_live', kcId: 'k_a', title: 'live' });
    const rows = await listActiveMisconceptionsForKcs(db, ['k_a']);
    expect(rows.map((r) => r.id)).toEqual(['misc_live']);
  });

  it('excludes misconceptions edged only to OTHER (unqueried) KCs', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_other', kcId: 'k_other', title: 'off-scope' });
    expect(await listActiveMisconceptionsForKcs(db, ['k_xuci'])).toEqual([]);
  });

  it('orders most-recurrent first (seen desc)', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_low', kcId: 'k_a', title: 'low', seen: 1 });
    await seedMisc({ id: 'misc_high', kcId: 'k_a', title: 'high', seen: 9 });
    await seedMisc({ id: 'misc_mid', kcId: 'k_a', title: 'mid', seen: 5 });
    const rows = await listActiveMisconceptionsForKcs(db, ['k_a']);
    expect(rows.map((r) => r.id)).toEqual(['misc_high', 'misc_mid', 'misc_low']);
  });

  it('honest empty: no miscs / blank ids / empty input → []', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_x', kcId: 'k_a', title: 'x' });
    expect(await listActiveMisconceptionsForKcs(db, [])).toEqual([]);
    expect(await listActiveMisconceptionsForKcs(db, ['  ', ''])).toEqual([]);
    expect(await listActiveMisconceptionsForKcs(db, ['k_unrelated'])).toEqual([]);
  });
});

describe('getMisconceptionsByIds', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('resolves active misc nodes by id (variant targetability + display use)', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_byid_1', kcId: 'k_a', title: '误区甲', reasoning: 'r1', seen: 4 });
    await seedMisc({ id: 'misc_byid_2', kcId: 'k_b', title: '误区乙' });
    const rows = await getMisconceptionsByIds(db, ['misc_byid_1', 'misc_byid_2', 'misc_gone']);
    // Ordering is seen-desc (misc_byid_1 first), not input order.
    expect(rows.map((r) => r.id)).toEqual(['misc_byid_1', 'misc_byid_2']);
    expect(rows[0].title).toBe('误区甲');
    expect(rows[0].reasoning).toBe('r1');
  });

  it('excludes draft / archived nodes (retracted resolves to nothing)', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_draft2', kcId: 'k_a', title: 'draft', status: 'draft' });
    await seedMisc({ id: 'misc_arch2', kcId: 'k_a', title: 'archived', miscArchived: true });
    await seedMisc({ id: 'misc_live2', kcId: 'k_a', title: 'live' });
    const rows = await getMisconceptionsByIds(db, ['misc_draft2', 'misc_arch2', 'misc_live2']);
    expect(rows.map((r) => r.id)).toEqual(['misc_live2']);
  });

  it('empty / blank input → []', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_e', kcId: 'k_a', title: 'x' });
    expect(await getMisconceptionsByIds(db, [])).toEqual([]);
    expect(await getMisconceptionsByIds(db, [' ', ''])).toEqual([]);
  });
});
