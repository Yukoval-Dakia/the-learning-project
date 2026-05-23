import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { writeEvent } from '../events/queries';
import { getEffectiveTruth } from './effective-truth';

const BASE_TIME = new Date('2026-05-23T00:00:00Z');

async function seedAttempt(id: string, createdAt = BASE_TIME): Promise<void> {
  await writeEvent(testDb(), {
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: `q_${id}`,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
    created_at: createdAt,
  });
}

async function seedCorrection(opts: {
  id: string;
  target_event_id: string;
  correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  replacement_event_id?: string;
  created_at?: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
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
      affected_refs: [{ kind: 'question', id: `q_${opts.target_event_id}` }],
    },
    created_at: opts.created_at ?? BASE_TIME,
  });
}

describe('getEffectiveTruth', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns active for an uncorrected event', async () => {
    await seedAttempt('evt_active');

    await expect(getEffectiveTruth(testDb(), 'evt_active')).resolves.toEqual({
      original_event_id: 'evt_active',
      state: 'active',
      terminal_state: 'active',
      effective_event_id: 'evt_active',
      correction_event_id: null,
      replacement_event_id: null,
      chain: [
        {
          event_id: 'evt_active',
          state: 'active',
          correction_event_id: null,
          replacement_event_id: null,
        },
      ],
    });
  });

  it('follows supersede chains longer than one hop', async () => {
    await seedAttempt('evt_1');
    await seedAttempt('evt_2');
    await seedAttempt('evt_3');
    await seedCorrection({
      id: 'corr_1_to_2',
      target_event_id: 'evt_1',
      correction_kind: 'supersede',
      replacement_event_id: 'evt_2',
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });
    await seedCorrection({
      id: 'corr_2_to_3',
      target_event_id: 'evt_2',
      correction_kind: 'supersede',
      replacement_event_id: 'evt_3',
      created_at: new Date(BASE_TIME.getTime() + 2_000),
    });

    const truth = await getEffectiveTruth(testDb(), 'evt_1');

    expect(truth.state).toBe('superseded');
    expect(truth.terminal_state).toBe('active');
    expect(truth.effective_event_id).toBe('evt_3');
    expect(truth.correction_event_id).toBe('corr_1_to_2');
    expect(truth.replacement_event_id).toBe('evt_2');
    expect(truth.chain.map((step) => step.event_id)).toEqual(['evt_1', 'evt_2', 'evt_3']);
  });

  it('returns the terminal non-active state when a replacement is retracted', async () => {
    await seedAttempt('evt_1');
    await seedAttempt('evt_2');
    await seedCorrection({
      id: 'corr_supersede',
      target_event_id: 'evt_1',
      correction_kind: 'supersede',
      replacement_event_id: 'evt_2',
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });
    await seedCorrection({
      id: 'corr_retract',
      target_event_id: 'evt_2',
      correction_kind: 'retract',
      created_at: new Date(BASE_TIME.getTime() + 2_000),
    });

    const truth = await getEffectiveTruth(testDb(), 'evt_1');

    expect(truth.state).toBe('retracted');
    expect(truth.terminal_state).toBe('retracted');
    expect(truth.effective_event_id).toBe('evt_2');
    expect(truth.correction_event_id).toBe('corr_retract');
    expect(truth.chain.map((step) => step.state)).toEqual(['superseded', 'retracted']);
  });

  it('reports missing when a replacement event does not exist', async () => {
    await seedAttempt('evt_1');
    await seedCorrection({
      id: 'corr_missing',
      target_event_id: 'evt_1',
      correction_kind: 'supersede',
      replacement_event_id: 'evt_missing',
    });

    const truth = await getEffectiveTruth(testDb(), 'evt_1');

    expect(truth.state).toBe('missing');
    expect(truth.terminal_state).toBe('missing');
    expect(truth.effective_event_id).toBeNull();
    expect(truth.chain.map((step) => step.event_id)).toEqual(['evt_1']);
  });

  it('reports cycle when supersede replacements loop', async () => {
    await seedAttempt('evt_1');
    await seedAttempt('evt_2');
    await seedCorrection({
      id: 'corr_1_to_2',
      target_event_id: 'evt_1',
      correction_kind: 'supersede',
      replacement_event_id: 'evt_2',
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });
    await seedCorrection({
      id: 'corr_2_to_1',
      target_event_id: 'evt_2',
      correction_kind: 'supersede',
      replacement_event_id: 'evt_1',
      created_at: new Date(BASE_TIME.getTime() + 2_000),
    });

    const truth = await getEffectiveTruth(testDb(), 'evt_1');

    expect(truth.state).toBe('cycle');
    expect(truth.terminal_state).toBe('cycle');
    expect(truth.effective_event_id).toBeNull();
    expect(truth.chain.map((step) => step.event_id)).toEqual(['evt_1', 'evt_2']);
  });
});
