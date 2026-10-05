import { describe, expect, it } from 'vitest';

import type { ItemCalibrationRowSnapshotT } from '../schema/event/genesis';
import type { FoldEvent } from './fold-event';
import { foldItemCalibration } from './item_calibration';

// ====================================================================
// foldItemCalibration — PURE anchor-only fold tests (YUK-496 方案 A).
//
// No DB / no IO — the reducer is a pure function of the event SET. The core invariant is the
// ROUND-TRIP IDENTITY: fold(genesis(payload.row)) === payload.row byte for byte, including the
// load-bearing b / b_anchor / confidence floats, the nullable columns, and the opaque jsonb
// records. That identity is exactly what makes audit:projection report CLEAN after the backfill
// and what preserves b/confidence through a rebuild (the MFI/θ̂ protection the ticket demands).
// ====================================================================

const T0 = new Date('2026-08-26T00:00:00.000Z');
const T1 = new Date('2026-08-27T00:00:00.000Z');

// A faithful full-row snapshot with non-trivial values on both tracks (a realistic
// post-firm-up, post-KT row — NOT a single-field happy path).
const RICH_ROW: ItemCalibrationRowSnapshotT = {
  id: 'ic_1',
  question_id: 'q_1',
  b: -0.8420000038146973, // float4 round-trip value (a real `real` column read)
  confidence: 0.6200000047683716,
  track: 'hard',
  source: 'llm_prior',
  b_anchor: -0.8420000038146973,
  b_calib: -0.9100000262260437,
  calibration_n: 12,
  calibration_weight: 9.5,
  last_calibrated_at: T0,
  irt_a: null,
  irt_c: null,
  cdm_json: null,
  kt_json: { known: 0.82, learn: 0.18, slip: 0.1, guess: 0.25 },
  created_at: T0,
  updated_at: T1,
};

function genesisEvent(row: ItemCalibrationRowSnapshotT, over: Partial<FoldEvent> = {}): FoldEvent {
  return {
    id: `ev_genesis_${row.id}`,
    created_at: T1,
    actor_kind: 'system',
    actor_ref: 'genesis-backfill',
    action: 'experimental:genesis',
    subject_kind: 'item_calibration',
    subject_id: row.id,
    outcome: 'success',
    caused_by_event_id: null,
    payload: { row },
    ...over,
  };
}

describe('foldItemCalibration — round-trip identity (anchor-only fold)', () => {
  it('fold(genesis) === payload.row BYTE FOR BYTE (b/confidence preserved)', () => {
    const folded = foldItemCalibration('ic_1', [genesisEvent(RICH_ROW)]);
    expect(folded).toEqual(RICH_ROW);
    // The load-bearing columns, asserted by name (not just the whole-object toEqual): the
    // MFI/θ̂ selection signal must survive the backfill+fold round-trip exactly.
    expect(folded?.b).toBe(RICH_ROW.b);
    expect(folded?.b_anchor).toBe(RICH_ROW.b_anchor);
    expect(folded?.confidence).toBe(RICH_ROW.confidence);
    expect(folded?.b_calib).toBe(RICH_ROW.b_calib);
    expect(folded?.kt_json).toEqual(RICH_ROW.kt_json);
  });

  it('a fully NULL-track row (soft placeholders, never calibrated) folds clean', () => {
    const coldRow: ItemCalibrationRowSnapshotT = {
      id: 'ic_2',
      question_id: 'q_2',
      b: 0.25,
      confidence: 0.3,
      track: 'hard',
      source: 'llm_prior',
      b_anchor: 0.25,
      b_calib: null,
      calibration_n: 0,
      calibration_weight: null,
      last_calibrated_at: null,
      irt_a: null,
      irt_c: null,
      cdm_json: null,
      kt_json: null,
      created_at: T0,
      updated_at: T0,
    };
    expect(foldItemCalibration('ic_2', [genesisEvent(coldRow)])).toEqual(coldRow);
  });

  it('no events → null (never anchored)', () => {
    expect(foldItemCalibration('ic_1', [])).toBeNull();
  });

  it('a genesis keyed on a DIFFERENT row is ignored (superset correctness)', () => {
    const other = genesisEvent({ ...RICH_ROW, id: 'ic_other', question_id: 'q_other' });
    expect(foldItemCalibration('ic_1', [other])).toBeNull();
  });

  it('non-genesis events for the same subject are ignored (anchor-only contract)', () => {
    const noise: FoldEvent = {
      ...genesisEvent(RICH_ROW),
      id: 'ev_noise',
      action: 'experimental:state_snapshot',
      payload: {},
    };
    const folded = foldItemCalibration('ic_1', [genesisEvent(RICH_ROW), noise]);
    expect(folded).toEqual(RICH_ROW);
  });

  it('LATEST anchor wins when a row somehow carries more than one genesis (keep-last)', () => {
    const refreshed: ItemCalibrationRowSnapshotT = {
      ...RICH_ROW,
      b: 1.25,
      b_anchor: 1.25,
      b_calib: null,
      calibration_n: 0,
      confidence: 0.9,
    };
    const first = genesisEvent(RICH_ROW, { id: 'ev_gen_a', created_at: T0 });
    const second = genesisEvent(refreshed, { id: 'ev_gen_b', created_at: T1 });
    // Arrival order must not matter — (created_at asc, id asc) keep-last is deterministic.
    expect(foldItemCalibration('ic_1', [second, first])).toEqual(refreshed);
    expect(foldItemCalibration('ic_1', [first, second])).toEqual(refreshed);
  });

  it('a MALFORMED genesis payload.row is skipped with a warn (never trusted)', () => {
    const malformed: FoldEvent = {
      ...genesisEvent(RICH_ROW),
      payload: { row: { id: 'ic_1', bogus: true } }, // fails ItemCalibrationRowSnapshot .strict()
    };
    expect(foldItemCalibration('ic_1', [malformed])).toBeNull();
  });

  it('a malformed genesis is skipped but a LATER well-formed anchor still seeds the row', () => {
    const malformed: FoldEvent = {
      ...genesisEvent(RICH_ROW),
      id: 'ev_bad',
      created_at: T0,
      payload: { row: { id: 'ic_1', bogus: true } },
    };
    const good = genesisEvent(RICH_ROW, { id: 'ev_good', created_at: T1 });
    expect(foldItemCalibration('ic_1', [malformed, good])).toEqual(RICH_ROW);
  });

  it('an envelope failing GenesisExperimental (wrong actor_kind) is skipped', () => {
    const badActor: FoldEvent = {
      ...genesisEvent(RICH_ROW),
      actor_kind: 'user', // genesis is pinned to 'system' — envelope fails safeParse
    };
    expect(foldItemCalibration('ic_1', [badActor])).toBeNull();
  });
});
