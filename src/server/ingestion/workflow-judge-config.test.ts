/**
 * Tests for the auto-enroll flag config — T-OC slice 3 (YUK-145, OC-5).
 *
 * The headline assertion: the flag is OFF by default (opt-IN, the INVERSE of the
 * WAVE6_TRIGGER_* opt-OUT convention). Pure, no DB. See ADR-0026.
 */
import { describe, expect, it } from 'vitest';

import {
  AUTO_ENROLL_FLAG,
  AUTO_ENROLL_THRESHOLD_FLAG,
  DEFAULT_AUTO_ENROLL_THRESHOLD,
  autoEnrollEnabled,
  autoEnrollThreshold,
} from './workflow-judge-config';

describe('autoEnrollEnabled', () => {
  it('is OFF when the env var is undefined (the production default)', () => {
    expect(autoEnrollEnabled({})).toBe(false);
  });

  it("is OFF for '' / 'false' / arbitrary values (opt-IN polarity)", () => {
    expect(autoEnrollEnabled({ [AUTO_ENROLL_FLAG]: '' })).toBe(false);
    expect(autoEnrollEnabled({ [AUTO_ENROLL_FLAG]: 'false' })).toBe(false);
    expect(autoEnrollEnabled({ [AUTO_ENROLL_FLAG]: '0' })).toBe(false);
    expect(autoEnrollEnabled({ [AUTO_ENROLL_FLAG]: 'yes' })).toBe(false);
    expect(autoEnrollEnabled({ [AUTO_ENROLL_FLAG]: 'on' })).toBe(false);
  });

  it("is ON only when explicitly 'true' (case-insensitive)", () => {
    expect(autoEnrollEnabled({ [AUTO_ENROLL_FLAG]: 'true' })).toBe(true);
    expect(autoEnrollEnabled({ [AUTO_ENROLL_FLAG]: 'TRUE' })).toBe(true);
    expect(autoEnrollEnabled({ [AUTO_ENROLL_FLAG]: 'True' })).toBe(true);
  });
});

describe('autoEnrollThreshold', () => {
  it('defaults to 0.85 when unset / blank / invalid', () => {
    expect(autoEnrollThreshold({})).toBe(DEFAULT_AUTO_ENROLL_THRESHOLD);
    expect(autoEnrollThreshold({ [AUTO_ENROLL_THRESHOLD_FLAG]: '' })).toBe(
      DEFAULT_AUTO_ENROLL_THRESHOLD,
    );
    expect(autoEnrollThreshold({ [AUTO_ENROLL_THRESHOLD_FLAG]: 'abc' })).toBe(
      DEFAULT_AUTO_ENROLL_THRESHOLD,
    );
  });

  it('parses + clamps to [0, 1]', () => {
    expect(autoEnrollThreshold({ [AUTO_ENROLL_THRESHOLD_FLAG]: '0.7' })).toBeCloseTo(0.7);
    expect(autoEnrollThreshold({ [AUTO_ENROLL_THRESHOLD_FLAG]: '-1' })).toBe(0);
    expect(autoEnrollThreshold({ [AUTO_ENROLL_THRESHOLD_FLAG]: '2' })).toBe(1);
  });
});
