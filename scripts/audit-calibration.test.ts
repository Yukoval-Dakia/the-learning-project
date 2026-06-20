// OCR finding 9 (isolated, no-DB): robust created_at parsing for the audit loader.
//
// audit-calibration.ts runs loadEnv() at module top (fills empty env only, never throws)
// and dynamic-imports @/db/client ONLY inside loadAttempts(), so importing this module for
// the pure parseCreatedAt helper touches no Postgres → safe in the unit (no-DB) car.

import { describe, expect, it } from 'vitest';
import { parseCreatedAt } from './audit-calibration';

describe('parseCreatedAt — OCR finding 9 (robust Date | string | number)', () => {
  it('Date → epoch ms', () => {
    const d = new Date('2026-06-20T12:00:00.000Z');
    expect(parseCreatedAt(d, 'e1')).toBe(d.getTime());
  });

  it('number → returned as-is (epoch ms)', () => {
    expect(parseCreatedAt(1_700_000_000_000, 'e2')).toBe(1_700_000_000_000);
  });

  it('ISO string → parsed to epoch ms (was NaN under the old Number() fallback)', () => {
    const iso = '2026-06-20T12:00:00.000Z';
    // Number('2026-06-20T...') === NaN — the bug. parseCreatedAt must parse it correctly.
    expect(Number.isNaN(Number(iso))).toBe(true); // documents the old failure mode
    expect(parseCreatedAt(iso, 'e3')).toBe(Date.parse(iso));
  });

  it('unparseable string throws (no silent NaN epoch that would scramble ordering)', () => {
    expect(() => parseCreatedAt('not-a-date', 'e4')).toThrow(/unparseable created_at/);
  });

  it('invalid Date throws', () => {
    expect(() => parseCreatedAt(new Date('nonsense'), 'e5')).toThrow(/invalid Date/);
  });

  it('non-finite number throws', () => {
    expect(() => parseCreatedAt(Number.NaN, 'e6')).toThrow(/non-finite/);
  });

  it('unsupported type (null/object) throws', () => {
    expect(() => parseCreatedAt(null, 'e7')).toThrow(/unsupported created_at type/);
    expect(() => parseCreatedAt({}, 'e8')).toThrow(/unsupported created_at type/);
  });
});
