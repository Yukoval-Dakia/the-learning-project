// P5.6 / YUK-178 — AC-4: TeachingDrawer corrective-redo trigger pure helper at
// the N=3 (total, not consecutive) boundary. Single-source const.

import { describe, expect, it } from 'vitest';

import { TEACHING_CORRECTIVE_FAILURE_N, isCorrectiveRedo } from './teaching';

describe('isCorrectiveRedo (AC-4, §4.3)', () => {
  it('pins the single-source threshold const at 3', () => {
    expect(TEACHING_CORRECTIVE_FAILURE_N).toBe(3);
  });

  it('is proactive (false) below the threshold', () => {
    expect(isCorrectiveRedo(0)).toBe(false);
    expect(isCorrectiveRedo(1)).toBe(false);
    expect(isCorrectiveRedo(2)).toBe(false);
  });

  it('flips corrective (true) at exactly N=3 (total)', () => {
    expect(isCorrectiveRedo(3)).toBe(true);
  });

  it('stays corrective above the threshold', () => {
    expect(isCorrectiveRedo(4)).toBe(true);
    expect(isCorrectiveRedo(10)).toBe(true);
  });

  it('treats absent/null/undefined counts as 0 → proactive (question-creation turn, PIN 8)', () => {
    expect(isCorrectiveRedo(undefined)).toBe(false);
    expect(isCorrectiveRedo(null)).toBe(false);
  });

  it('boundary is total failures, expressed via the shared const (no magic number)', () => {
    expect(isCorrectiveRedo(TEACHING_CORRECTIVE_FAILURE_N - 1)).toBe(false);
    expect(isCorrectiveRedo(TEACHING_CORRECTIVE_FAILURE_N)).toBe(true);
  });
});
