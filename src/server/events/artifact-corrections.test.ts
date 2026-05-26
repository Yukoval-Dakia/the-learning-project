import { event } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  activeArtifactCorrectionStatus,
  getArtifactCorrectionState,
  getArtifactCorrectionStates,
} from './artifact-corrections';
import { writeEvent } from './queries';

const BASE_TIME = new Date('2026-05-26T00:00:00Z');

async function seedArtifactCorrection(opts: {
  id: string;
  artifact_id: string;
  correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  section_id?: string;
  replacement_artifact_id?: string;
  reason_md?: string;
  created_at?: Date;
}): Promise<void> {
  const db = testDb();
  await writeEvent(db, {
    id: opts.id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'artifact',
    subject_id: opts.artifact_id,
    outcome: 'success',
    payload: {
      correction_kind: opts.correction_kind,
      ...(opts.section_id !== undefined ? { section_id: opts.section_id } : {}),
      ...(opts.replacement_artifact_id !== undefined
        ? { replacement_artifact_id: opts.replacement_artifact_id }
        : {}),
      reason_md: opts.reason_md ?? 'manual correction',
    },
    created_at: opts.created_at ?? BASE_TIME,
  });
}

describe('artifact correction projection', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns whole=active and empty sections when no correction events exist', async () => {
    const db = testDb();
    const state = await getArtifactCorrectionState(db, 'artifact_42');

    expect(state.whole).toEqual(activeArtifactCorrectionStatus());
    expect(state.sections.size).toBe(0);
  });

  it('projects whole-artifact mark_wrong when section_id is omitted', async () => {
    const db = testDb();
    await seedArtifactCorrection({
      id: 'corr_1',
      artifact_id: 'artifact_42',
      correction_kind: 'mark_wrong',
    });

    const state = await getArtifactCorrectionState(db, 'artifact_42');
    expect(state.whole).toEqual({
      state: 'marked_wrong',
      correction_event_id: 'corr_1',
      replacement_artifact_id: null,
    });
    expect(state.sections.size).toBe(0);
  });

  it('projects per-section state independently from whole-artifact state', async () => {
    const db = testDb();
    await seedArtifactCorrection({
      id: 'corr_1',
      artifact_id: 'artifact_42',
      section_id: 'sec_pitfall',
      correction_kind: 'mark_wrong',
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });
    await seedArtifactCorrection({
      id: 'corr_2',
      artifact_id: 'artifact_42',
      section_id: 'sec_example',
      correction_kind: 'retract',
      created_at: new Date(BASE_TIME.getTime() + 2_000),
    });

    const state = await getArtifactCorrectionState(db, 'artifact_42');
    expect(state.whole).toEqual(activeArtifactCorrectionStatus());
    expect(state.sections.get('sec_pitfall')).toEqual({
      state: 'marked_wrong',
      correction_event_id: 'corr_1',
      replacement_artifact_id: null,
    });
    expect(state.sections.get('sec_example')).toEqual({
      state: 'retracted',
      correction_event_id: 'corr_2',
      replacement_artifact_id: null,
    });
  });

  it('returns to active after restore (latest event wins)', async () => {
    const db = testDb();
    await seedArtifactCorrection({
      id: 'corr_mark',
      artifact_id: 'artifact_42',
      section_id: 'sec_pitfall',
      correction_kind: 'mark_wrong',
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });
    await seedArtifactCorrection({
      id: 'corr_restore',
      artifact_id: 'artifact_42',
      section_id: 'sec_pitfall',
      correction_kind: 'restore',
      created_at: new Date(BASE_TIME.getTime() + 2_000),
    });

    const state = await getArtifactCorrectionState(db, 'artifact_42');
    expect(state.sections.get('sec_pitfall') ?? activeArtifactCorrectionStatus()).toEqual(
      activeArtifactCorrectionStatus(),
    );
  });

  it('projects supersede with replacement_artifact_id terminal redirect', async () => {
    const db = testDb();
    await seedArtifactCorrection({
      id: 'corr_supersede',
      artifact_id: 'artifact_old',
      correction_kind: 'supersede',
      replacement_artifact_id: 'artifact_new',
    });

    const state = await getArtifactCorrectionState(db, 'artifact_old');
    expect(state.whole).toEqual({
      state: 'superseded',
      correction_event_id: 'corr_supersede',
      replacement_artifact_id: 'artifact_new',
    });
  });

  it('does not pick up subject_kind=event correction rows', async () => {
    const db = testDb();
    // Seed an event-target correction; should be invisible to artifact projection.
    await writeEvent(testDb(), {
      id: 'event_corr_1',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'some_event_id',
      outcome: 'success',
      payload: {
        correction_kind: 'mark_wrong',
        reason_md: 'event-target correction',
        affected_refs: [{ kind: 'question', id: 'q1' }],
      },
      created_at: BASE_TIME,
    });

    const state = await getArtifactCorrectionState(db, 'some_event_id');
    expect(state.whole).toEqual(activeArtifactCorrectionStatus());
    expect(state.sections.size).toBe(0);
  });

  it('applies events in (created_at, id) order so later mark_wrong overrides earlier restore', async () => {
    const db = testDb();
    // Insert restore first chronologically, then mark_wrong later — final state should be marked_wrong.
    await seedArtifactCorrection({
      id: 'corr_restore_early',
      artifact_id: 'artifact_42',
      correction_kind: 'restore',
      created_at: new Date(BASE_TIME.getTime() + 1_000),
    });
    await seedArtifactCorrection({
      id: 'corr_mark_late',
      artifact_id: 'artifact_42',
      correction_kind: 'mark_wrong',
      created_at: new Date(BASE_TIME.getTime() + 2_000),
    });

    const state = await getArtifactCorrectionState(db, 'artifact_42');
    expect(state.whole).toEqual({
      state: 'marked_wrong',
      correction_event_id: 'corr_mark_late',
      replacement_artifact_id: null,
    });
  });

  it('breaks identical created_at ties by event id (lexicographic ascending)', async () => {
    const db = testDb();
    const sameTime = new Date(BASE_TIME.getTime() + 5_000);
    await seedArtifactCorrection({
      id: 'corr_a',
      artifact_id: 'artifact_42',
      correction_kind: 'retract',
      created_at: sameTime,
    });
    await seedArtifactCorrection({
      id: 'corr_b',
      artifact_id: 'artifact_42',
      correction_kind: 'mark_wrong',
      created_at: sameTime,
    });

    const state = await getArtifactCorrectionState(db, 'artifact_42');
    // Both rows share created_at; ORDER BY (created_at, id) ASC means corr_a
    // is applied first, then corr_b overrides — final state reflects corr_b.
    expect(state.whole).toEqual({
      state: 'marked_wrong',
      correction_event_id: 'corr_b',
      replacement_artifact_id: null,
    });
  });

  it('batches multiple artifacts in one round trip', async () => {
    const db = testDb();
    await seedArtifactCorrection({
      id: 'corr_a',
      artifact_id: 'artifact_a',
      correction_kind: 'mark_wrong',
    });
    await seedArtifactCorrection({
      id: 'corr_b',
      artifact_id: 'artifact_b',
      section_id: 'sec_pitfall',
      correction_kind: 'retract',
    });

    const map = await getArtifactCorrectionStates(db, [
      'artifact_a',
      'artifact_b',
      'artifact_untouched',
    ]);
    expect(map.get('artifact_a')?.whole.state).toBe('marked_wrong');
    expect(map.get('artifact_b')?.sections.get('sec_pitfall')?.state).toBe('retracted');
    expect(map.get('artifact_untouched')).toBeUndefined();
  });
});
