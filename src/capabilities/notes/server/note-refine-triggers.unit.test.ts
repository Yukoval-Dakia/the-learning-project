import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOTE_REFINE_TRIGGER_DEBOUNCE_MS,
  enqueueMarkWrongNoteRefine,
  enqueueNoteRefineTrigger,
  enqueueVerifyNoteRefine,
  noteRefineTriggerEnabled,
  resetNoteRefineTriggerStateForTests,
} from '@/capabilities/notes/server/note-refine-triggers';

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
        kind: 'mark_wrong',
        triggerEventId: 'evt_attempt_1',
        now,
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'enqueued', artifact_id: 'art_1', kind: 'mark_wrong' });
    await expect(
      enqueueNoteRefineTrigger({
        artifactId: 'art_1',
        kind: 'mark_wrong',
        now: new Date(now.getTime() + 10_000),
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'skipped:debounced' });
    await expect(
      enqueueNoteRefineTrigger({
        artifactId: 'art_1',
        kind: 'mark_wrong',
        now: new Date(now.getTime() + NOTE_REFINE_TRIGGER_DEBOUNCE_MS + 1),
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'enqueued' });

    expect(bossSend).toHaveBeenCalledTimes(2);
    expect(bossSend).toHaveBeenCalledWith('note_refine', {
      artifact_id: 'art_1',
      trigger: {
        kind: 'mark_wrong',
        context_md: undefined,
        evidence_ids: undefined,
        trigger_event_id: 'evt_attempt_1',
      },
    });
  });

  it('honors kill switches before touching pg-boss', async () => {
    // YUK-358 决定6 — dwell trigger retired; keep kill-switch coverage on a
    // SURVIVING real-signal kind (mastery_change).
    const bossSend = vi.fn(async () => undefined);
    const env = { ...process.env, WAVE6_TRIGGER_MASTERY_ENABLED: 'false' };

    expect(noteRefineTriggerEnabled('mastery_change', env)).toBe(false);
    await expect(
      enqueueNoteRefineTrigger({
        artifactId: 'art_1',
        kind: 'mastery_change',
        env,
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'skipped:disabled' });
    expect(bossSend).not.toHaveBeenCalled();
  });

  // RED-2 (YUK-358 决定7) — the verify kind is OPT-IN (default-OFF). Unlike the
  // other 4 kinds (default-ON), an UNSET WAVE6_TRIGGER_VERIFY_ENABLED flag must
  // skip the enqueue so deleting note_verify's dead proposal does NOT silently
  // turn on a new AI-cost path. Setting the flag to "true" opts in.
  it('verify kind is default-OFF: unset flag skips without touching pg-boss', async () => {
    const bossSend = vi.fn(async () => undefined);
    const env: NodeJS.ProcessEnv = { ...process.env, WAVE6_TRIGGER_VERIFY_ENABLED: undefined };

    expect(noteRefineTriggerEnabled('verify', env)).toBe(false);
    await expect(
      enqueueVerifyNoteRefine({
        artifactId: 'art_v',
        triggerEventId: 'evt_verify_1',
        contextMd: 'Verify summary: 例句解释缺少文本证据。',
        env,
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'skipped:disabled', artifact_id: 'art_v', kind: 'verify' });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('verify kind opts in when WAVE6_TRIGGER_VERIFY_ENABLED="true" and forwards verify context', async () => {
    const bossSend = vi.fn(async () => undefined);
    const env = { ...process.env, WAVE6_TRIGGER_VERIFY_ENABLED: 'true' };

    expect(noteRefineTriggerEnabled('verify', env)).toBe(true);
    await expect(
      enqueueVerifyNoteRefine({
        artifactId: 'art_v',
        triggerEventId: 'evt_verify_1',
        contextMd: 'Verify summary: 例句解释缺少文本证据。',
        env,
        bossSend,
      }),
    ).resolves.toMatchObject({ status: 'enqueued', artifact_id: 'art_v', kind: 'verify' });

    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith('note_refine', {
      artifact_id: 'art_v',
      trigger: {
        kind: 'verify',
        context_md: expect.stringContaining('Verify summary: 例句解释缺少文本证据。'),
        evidence_ids: ['evt_verify_1'],
        trigger_event_id: 'evt_verify_1',
      },
    });
  });

  // The surviving real-signal kinds stay default-ON: an unset flag still enqueues.
  // (YUK-358 决定6 — dwell removed from this set; verify covered separately above.)
  it('non-verify kinds stay default-ON (unset flag still enabled)', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WAVE6_TRIGGER_MARK_WRONG_ENABLED: undefined,
      WAVE6_TRIGGER_MASTERY_ENABLED: undefined,
      WAVE6_TRIGGER_DREAMING_ENABLED: undefined,
    };
    expect(noteRefineTriggerEnabled('mark_wrong', env)).toBe(true);
    expect(noteRefineTriggerEnabled('mastery_change', env)).toBe(true);
    expect(noteRefineTriggerEnabled('dreaming', env)).toBe(true);
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
