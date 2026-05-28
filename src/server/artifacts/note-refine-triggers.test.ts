import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOTE_REFINE_TRIGGER_DEBOUNCE_MS,
  enqueueMarkWrongNoteRefine,
  enqueueNoteRefineTrigger,
  noteRefineTriggerEnabled,
  resetNoteRefineTriggerStateForTests,
} from '@/server/artifacts/note-refine-triggers';

describe('note refine trigger producer', () => {
  beforeEach(() => {
    resetNoteRefineTriggerStateForTests();
  });

  it('enqueues enabled triggers and debounces repeated artifact/kind pairs', async () => {
    const bossSend = vi.fn(async () => undefined);
    const now = new Date('2026-05-28T12:00:00.000Z');

    await expect(
      enqueueNoteRefineTrigger({
        artifactId: 'art_1',
        kind: 'error_rate',
        triggerEventId: 'evt_attempt_1',
        now,
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'enqueued', artifact_id: 'art_1', kind: 'error_rate' });
    await expect(
      enqueueNoteRefineTrigger({
        artifactId: 'art_1',
        kind: 'error_rate',
        now: new Date(now.getTime() + 10_000),
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'skipped:debounced' });
    await expect(
      enqueueNoteRefineTrigger({
        artifactId: 'art_1',
        kind: 'error_rate',
        now: new Date(now.getTime() + NOTE_REFINE_TRIGGER_DEBOUNCE_MS + 1),
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'enqueued' });

    expect(bossSend).toHaveBeenCalledTimes(2);
    expect(bossSend).toHaveBeenCalledWith('note_refine', {
      artifact_id: 'art_1',
      trigger: {
        kind: 'error_rate',
        context_md: undefined,
        evidence_ids: undefined,
        trigger_event_id: 'evt_attempt_1',
      },
    });
  });

  it('honors kill switches before touching pg-boss', async () => {
    const bossSend = vi.fn(async () => undefined);
    const env = { ...process.env, WAVE6_TRIGGER_DWELL_ENABLED: 'false' };

    expect(noteRefineTriggerEnabled('dwell', env)).toBe(false);
    await expect(
      enqueueNoteRefineTrigger({
        artifactId: 'art_1',
        kind: 'dwell',
        env,
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'skipped:disabled' });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('adds mark_wrong evidence context from the correction event', async () => {
    const bossSend = vi.fn(async () => undefined);

    await enqueueMarkWrongNoteRefine({
      artifactId: 'art_1',
      blockId: 'block_1',
      reasonMd: '符号方向错了',
      triggerEventId: 'evt_correct_1',
      bossSend,
    });

    expect(bossSend).toHaveBeenCalledWith('note_refine', {
      artifact_id: 'art_1',
      trigger: expect.objectContaining({
        kind: 'mark_wrong',
        context_md: expect.stringContaining('block_id=block_1'),
        evidence_ids: ['evt_correct_1'],
        trigger_event_id: 'evt_correct_1',
      }),
    });
  });
});
