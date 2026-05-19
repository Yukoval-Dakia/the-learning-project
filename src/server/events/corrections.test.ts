import { event } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getCorrectionStatus, getCorrectionStatuses } from './corrections';
import { writeEvent } from './queries';

const BASE_TIME = new Date('2026-05-19T00:00:00Z');

async function seedAttempt(id: string, created_at = BASE_TIME): Promise<void> {
  const db = testDb();
  await writeEvent(db, {
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
    created_at,
  });
}

async function seedCorrection(opts: {
  id: string;
  target_event_id: string;
  correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  replacement_event_id?: string;
  created_at?: Date;
}): Promise<void> {
  const db = testDb();
  await writeEvent(db, {
    id: opts.id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.target_event_id,
    outcome: 'success',
    payload: {
      correction_kind: opts.correction_kind,
      replacement_event_id: opts.replacement_event_id,
      reason_md: 'manual correction',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    },
    created_at: opts.created_at ?? BASE_TIME,
  });
}

describe('correction status projection', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns active when no correction targets the event', async () => {
    const db = testDb();
    await seedAttempt('evt_target');

    await expect(getCorrectionStatus(db, 'evt_target')).resolves.toEqual({
      state: 'active',
      correction_event_id: null,
      replacement_event_id: null,
    });
  });

  it('projects retracted, marked_wrong, and superseded statuses in batches', async () => {
    const db = testDb();
    await seedAttempt('evt_retracted');
    await seedAttempt('evt_marked_wrong');
    await seedAttempt('evt_superseded');
    await seedCorrection({
      id: 'evt_correct_1',
      target_event_id: 'evt_retracted',
      correction_kind: 'retract',
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });
    await seedCorrection({
      id: 'evt_correct_2',
      target_event_id: 'evt_marked_wrong',
      correction_kind: 'mark_wrong',
      created_at: new Date(BASE_TIME.getTime() + 2_000),
    });
    await seedCorrection({
      id: 'evt_correct_3',
      target_event_id: 'evt_superseded',
      correction_kind: 'supersede',
      replacement_event_id: 'evt_replacement',
      created_at: new Date(BASE_TIME.getTime() + 3_000),
    });

    const statuses = await getCorrectionStatuses(db, [
      'evt_retracted',
      'evt_marked_wrong',
      'evt_superseded',
    ]);

    expect(statuses.get('evt_retracted')).toEqual({
      state: 'retracted',
      correction_event_id: 'evt_correct_1',
      replacement_event_id: null,
    });
    expect(statuses.get('evt_marked_wrong')).toEqual({
      state: 'marked_wrong',
      correction_event_id: 'evt_correct_2',
      replacement_event_id: null,
    });
    expect(statuses.get('evt_superseded')).toEqual({
      state: 'superseded',
      correction_event_id: 'evt_correct_3',
      replacement_event_id: 'evt_replacement',
    });
  });

  it('applies corrections by created_at then id, so restore can reactivate an event', async () => {
    const db = testDb();
    await seedAttempt('evt_target');
    const sameTime = new Date(BASE_TIME.getTime() + 1_000);
    await seedCorrection({
      id: 'evt_correct_1_retract',
      target_event_id: 'evt_target',
      correction_kind: 'retract',
      created_at: sameTime,
    });
    await seedCorrection({
      id: 'evt_correct_2_restore',
      target_event_id: 'evt_target',
      correction_kind: 'restore',
      created_at: sameTime,
    });

    await expect(getCorrectionStatus(db, 'evt_target')).resolves.toEqual({
      state: 'active',
      correction_event_id: null,
      replacement_event_id: null,
    });
  });

  it('ignores corrections targeting other events', async () => {
    const db = testDb();
    await seedAttempt('evt_target');
    await seedAttempt('evt_other');
    await seedCorrection({
      id: 'evt_correct_other',
      target_event_id: 'evt_other',
      correction_kind: 'retract',
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });

    const statuses = await getCorrectionStatuses(db, ['evt_target', 'evt_other']);

    expect(statuses.get('evt_target')).toEqual({
      state: 'active',
      correction_event_id: null,
      replacement_event_id: null,
    });
    expect(statuses.get('evt_other')?.state).toBe('retracted');
  });

  it('ignores malformed correction rows instead of throwing in status projection', async () => {
    const db = testDb();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedAttempt('evt_target');
    await db.insert(event).values({
      id: 'evt_malformed_correct',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'evt_target',
      outcome: 'success',
      payload: { correction_kind: 'retract' },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });

    await expect(getCorrectionStatus(db, 'evt_target')).resolves.toEqual({
      state: 'active',
      correction_event_id: null,
      replacement_event_id: null,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'getCorrectionStatuses: skipping malformed correction event',
      expect.objectContaining({ event_id: 'evt_malformed_correct' }),
    );
    warnSpy.mockRestore();
  });
});
