import { describe, expect, it } from 'vitest';
import { parseFlag } from './env-flags';

describe('parseFlag', () => {
  it.each(['true', 'TRUE', ' True ', '1', ' 1 '])('parses %j as enabled', (value) => {
    expect(parseFlag(value)).toBe(true);
  });

  it.each(['false', 'FALSE', ' False ', '0', ' 0 '])('parses %j as disabled', (value) => {
    expect(parseFlag(value, { defaultValue: true })).toBe(false);
  });

  it('uses the declared polarity default for absent, blank, and unknown values', () => {
    for (const value of [undefined, '', '   ', 'yes', 'on']) {
      expect(parseFlag(value)).toBe(false);
      expect(parseFlag(value, { defaultValue: true })).toBe(true);
    }
  });
});
