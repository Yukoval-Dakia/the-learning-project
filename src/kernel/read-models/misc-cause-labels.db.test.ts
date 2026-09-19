// YUK-1018 (454-A 下游) — `resolveMiscCauseLabels` by-id 显示回填：active misc
// → title；draft / archived / unknown → 缺席（调用方回退裸 id）；非 misc 前缀
// id 不查表。

import { beforeEach, describe, expect, it } from 'vitest';
import { misconception } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { isMiscCauseId, resolveMiscCauseLabels } from './misc-cause-labels';

async function seedMisc(opts: {
  id: string;
  title: string;
  status?: string;
  archived?: boolean;
}): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(misconception)
    .values({
      id: opts.id,
      title: opts.title,
      reasoning: null,
      weight: 1,
      status: opts.status ?? 'active',
      source: 'soft',
      seen: 0,
      evidence: [],
      created_by: { by: 'system' },
      proposed_by_ai: true,
      created_at: now,
      updated_at: now,
      archived_at: opts.archived ? now : null,
    });
}

describe('resolveMiscCauseLabels', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('resolves an active misc id to its title', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_abc123', title: '把除法当乘法' });
    const labels = await resolveMiscCauseLabels(db, ['misc_abc123']);
    expect(labels.get('misc_abc123')).toBe('把除法当乘法');
  });

  it('excludes draft / archived / unknown misc ids (caller falls back to raw id)', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_draft', title: 'draft', status: 'draft' });
    await seedMisc({ id: 'misc_arch', title: 'arch', archived: true });
    const labels = await resolveMiscCauseLabels(db, [
      'misc_draft',
      'misc_arch',
      'misc_never_existed',
    ]);
    expect(labels.size).toBe(0);
  });

  it('ignores non-misc ids — vocab categories never hit the table', async () => {
    const db = testDb();
    // Seed an active misc AND confirm a vocab-shaped id still resolves nothing.
    await seedMisc({ id: 'misc_x', title: 'x' });
    const labels = await resolveMiscCauseLabels(db, ['concept_gap', 'other', 'misc_x']);
    expect([...labels.keys()]).toEqual(['misc_x']);
  });

  it('empty / blank input → empty map without touching the db', async () => {
    const db = testDb();
    expect(await resolveMiscCauseLabels(db, [])).toEqual(new Map());
    expect(await resolveMiscCauseLabels(db, ['concept_gap'])).toEqual(new Map());
  });

  it('dedupes repeated ids', async () => {
    const db = testDb();
    await seedMisc({ id: 'misc_dup', title: 'dup' });
    const labels = await resolveMiscCauseLabels(db, ['misc_dup', 'misc_dup', 'misc_dup']);
    expect(labels.size).toBe(1);
  });
});

describe('isMiscCauseId', () => {
  it('matches only the misc_ namespace', () => {
    expect(isMiscCauseId('misc_abc')).toBe(true);
    expect(isMiscCauseId('misc_')).toBe(true); // degenerate-but-prefixed still misc-shaped
    expect(isMiscCauseId('concept_gap')).toBe(false);
    expect(isMiscCauseId('ov_foo')).toBe(false);
    expect(isMiscCauseId('xmisc_abc')).toBe(false); // not a prefix match
  });
});
