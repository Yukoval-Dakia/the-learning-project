// YUK-734 — boundary coverage for the dedup-flags env-override resolvers. The three
// thresholds (DEDUP_DISTANCE_MAX / DEDUP_WINDOW_DAYS / DEDUP_MAX_PAIRS) are module-level
// consts resolved from process.env at IMPORT time by resolvePositive / resolvePositiveInt.
// Those resolvers encode two real past regressions:
//   - OCR #4:     a ≤0 cosine-distance ceiling would silently DISABLE all KC dedup
//                 (cosine distance is always > 0), so a non-positive override is rejected.
//   - augment #570: a fractional integer override truncates to 0 → LIMIT 0 / window 0,
//                 disabling the scan, so a truncated value < 1 is rejected.
// The resolvers are not exported, so each case sets env → vi.resetModules() → fresh
// import and asserts the regression semantics through the real exported const. Zero
// production change.

import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['KC_DEDUP_DISTANCE_MAX', 'KC_DEDUP_WINDOW_DAYS', 'KC_DEDUP_MAX_PAIRS'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const original: Record<EnvKey, string | undefined> = {
  KC_DEDUP_DISTANCE_MAX: process.env.KC_DEDUP_DISTANCE_MAX,
  KC_DEDUP_WINDOW_DAYS: process.env.KC_DEDUP_WINDOW_DAYS,
  KC_DEDUP_MAX_PAIRS: process.env.KC_DEDUP_MAX_PAIRS,
};

async function loadFlags(env: Partial<Record<EnvKey, string>>) {
  for (const key of ENV_KEYS) {
    const val = env[key];
    if (val === undefined) {
      delete process.env[key]; // real unset (not the string "undefined") for env isolation.
    } else {
      process.env[key] = val;
    }
  }
  vi.resetModules(); // force the module to re-run its top-level env reads on next import.
  return import('./dedup-flags');
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = original[key];
    if (prev === undefined) {
      delete process.env[key]; // restore the pre-test env exactly (unset stays unset).
    } else {
      process.env[key] = prev;
    }
  }
});

describe('dedup-flags env-override resolvers', () => {
  it('uses the built-in defaults when no override is set', async () => {
    const flags = await loadFlags({});
    expect(flags.DEDUP_DISTANCE_MAX).toBe(0.1);
    expect(flags.DEDUP_WINDOW_DAYS).toBe(7);
    expect(flags.DEDUP_MAX_PAIRS).toBe(50);
  });

  it('honors valid positive overrides (guards against a vacuous always-default resolver)', async () => {
    const flags = await loadFlags({
      KC_DEDUP_DISTANCE_MAX: '0.05',
      KC_DEDUP_WINDOW_DAYS: '14',
      KC_DEDUP_MAX_PAIRS: '10',
    });
    expect(flags.DEDUP_DISTANCE_MAX).toBe(0.05);
    expect(flags.DEDUP_WINDOW_DAYS).toBe(14);
    expect(flags.DEDUP_MAX_PAIRS).toBe(10);
  });

  // OCR #4 regression: a ≤0 cosine-distance ceiling would never match (distance > 0) →
  // silently disables all KC dedup. resolvePositive must reject it back to 0.1.
  it.each(['0', '-1', '-0.5'])(
    'rejects a non-positive KC_DEDUP_DISTANCE_MAX=%s back to the 0.1 default (OCR #4)',
    async (raw) => {
      const flags = await loadFlags({ KC_DEDUP_DISTANCE_MAX: raw });
      expect(flags.DEDUP_DISTANCE_MAX).toBe(0.1);
    },
  );

  // augment #570 regression: a sub-1 fractional override truncates to 0 → LIMIT 0 /
  // window 0 → disables the scan. resolvePositiveInt must reject it to the default.
  it.each([
    ['KC_DEDUP_MAX_PAIRS', '0.5', 50],
    ['KC_DEDUP_WINDOW_DAYS', '0.9', 7],
  ] as const)(
    'rejects a sub-1 fractional %s=%s back to its default (augment #570)',
    async (key, raw, expected) => {
      const flags = await loadFlags({ [key]: raw });
      const value = key === 'KC_DEDUP_MAX_PAIRS' ? flags.DEDUP_MAX_PAIRS : flags.DEDUP_WINDOW_DAYS;
      expect(value).toBe(expected);
    },
  );

  // A fractional value ≥ 1 truncates toward zero to a valid positive int (NOT rejected).
  it('truncates a ≥1 fractional integer override toward zero', async () => {
    const flags = await loadFlags({ KC_DEDUP_MAX_PAIRS: '12.9' });
    expect(flags.DEDUP_MAX_PAIRS).toBe(12);
  });

  it.each(['abc', '', '   ', 'NaN', 'Infinity'])(
    'falls back to all defaults for the unparseable/empty override %j',
    async (raw) => {
      const flags = await loadFlags({
        KC_DEDUP_DISTANCE_MAX: raw,
        KC_DEDUP_WINDOW_DAYS: raw,
        KC_DEDUP_MAX_PAIRS: raw,
      });
      expect(flags.DEDUP_DISTANCE_MAX).toBe(0.1);
      expect(flags.DEDUP_WINDOW_DAYS).toBe(7);
      expect(flags.DEDUP_MAX_PAIRS).toBe(50);
    },
  );
});
