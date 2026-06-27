// YUK-440 (A13) — kc_typed_state single-writer tests. Pure §修正-4 gate + DB upsert
// (concurrency serialization / deterministic transitions / evidence append-union).

import { db } from '@/db/client';
import { kc_typed_state } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from '../../../tests/helpers/db';
import {
  CONFUSED_WITH_RECURRENCE_FLOOR,
  type UpsertKcTypedStateInput,
  nextTypedState,
  upsertKcTypedState,
} from './typed-state';

// Pure gate (no DB) — kept here so all typed-state tests live together.
describe('nextTypedState (§修正-4 gate, pure)', () => {
  const base = {
    proposed: 'confused-with-X' as const,
    confused_with_kc_id: 'k_other',
    discriminating: true,
    recurrence_count: 2,
  };

  it('commits confused-with-X when discriminating AND recurrence>=2 AND a named KC', () => {
    const r = nextTypedState(base);
    expect(r.typed_state).toBe('confused-with-X');
    expect(r.confused_with_kc_id).toBe('k_other');
    expect(r.lifecycle).toBe('resolved');
  });

  it('stays soft (no-evidence/open) when the probe is NOT discriminating', () => {
    const r = nextTypedState({ ...base, discriminating: false });
    expect(r.typed_state).toBe('no-evidence');
    expect(r.confused_with_kc_id).toBeNull();
    expect(r.lifecycle).toBe('open');
  });

  it('stays soft when recurrence < floor', () => {
    expect(
      nextTypedState({ ...base, recurrence_count: CONFUSED_WITH_RECURRENCE_FLOOR - 1 }).typed_state,
    ).toBe('no-evidence');
  });

  it('stays soft when no confused_with KC is named', () => {
    expect(nextTypedState({ ...base, confused_with_kc_id: null }).typed_state).toBe('no-evidence');
  });

  it('never produces mastered (FLIP deferred, ADR-0046)', () => {
    for (const proposed of ['confused-with-X', 'no-evidence'] as const) {
      expect(nextTypedState({ ...base, proposed }).typed_state).not.toBe('mastered');
    }
  });
});

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

  it('writes confused-with-X for a confirmed discriminating recurrence', async () => {
    await upsertKcTypedState(db, {
      subject_id: 'k_a',
      proposed: 'confused-with-X',
      confused_with_kc_id: 'k_b',
      discriminating: true,
      recurrence_count: 3,
      evidence_event_ids: ['e1', 'e2'],
      last_evidence_at: new Date('2026-06-25T00:00:00Z'),
    });
    const r = await row('k_a');
    expect(r?.typed_state).toBe('confused-with-X');
    expect(r?.confused_with_kc_id).toBe('k_b');
    expect(r?.lifecycle).toBe('resolved');
    expect(r?.evidence_event_ids).toEqual(['e1', 'e2']);
  });

  it('stays no-evidence/open when the gate is not met (non-discriminating)', async () => {
    await upsertKcTypedState(db, {
      subject_id: 'k_soft',
      proposed: 'confused-with-X',
      confused_with_kc_id: 'k_b',
      discriminating: false,
      recurrence_count: 5,
      evidence_event_ids: ['e1'],
      last_evidence_at: new Date(),
    });
    const r = await row('k_soft');
    expect(r?.typed_state).toBe('no-evidence');
    expect(r?.confused_with_kc_id).toBeNull();
  });

  it('append-unions evidence_event_ids across updates (no lost evidence)', async () => {
    const input = (ids: string[]): UpsertKcTypedStateInput => ({
      subject_id: 'k_acc',
      proposed: 'no-evidence',
      discriminating: false,
      recurrence_count: 2,
      evidence_event_ids: ids,
      last_evidence_at: new Date(),
    });
    await upsertKcTypedState(db, input(['e1', 'e2']));
    await upsertKcTypedState(db, input(['e2', 'e3'])); // e2 duplicate
    const r = await row('k_acc');
    expect([...(r?.evidence_event_ids ?? [])].sort()).toEqual(['e1', 'e2', 'e3']);
  });

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

  it('last_evidence_at is monotonic — an older-timestamp update does not regress it', async () => {
    const newer = new Date('2026-06-25T00:00:00Z');
    const older = new Date('2026-06-20T00:00:00Z');
    const input = (ts: Date): UpsertKcTypedStateInput => ({
      subject_id: 'k_ts',
      proposed: 'no-evidence',
      discriminating: false,
      recurrence_count: 2,
      evidence_event_ids: ['e1'],
      last_evidence_at: ts,
    });
    await upsertKcTypedState(db, input(newer));
    await upsertKcTypedState(db, input(older)); // out-of-order older write
    const r = await row('k_ts');
    expect(r?.last_evidence_at?.getTime()).toBe(newer.getTime());
  });
});
