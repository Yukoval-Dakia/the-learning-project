// YUK-379 (OCR #2, round-2 minor) — parseLimit CLI arg parsing.
//
// Round-2 OCR: the original Number(raw) parse accepted non-decimal forms
// (`0x10` -> 16, `1e2` -> 100) — operator typos that should be REJECTED on a
// production backfill CLI, not silently reinterpreted. parseLimit now requires
// raw to match `/^\d+$/` (plain unsigned decimal digits only) before
// parseInt(raw, 10); anything else — non-numeric, hex, scientific notation,
// fractional, trailing garbage, non-positive — warns and falls back to
// DEFAULT_LIMIT.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMIT, parseLimit } from './backfill-lost-attribution';

describe('parseLimit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses --limit=<n>', () => {
    expect(parseLimit(['--limit=50'])).toBe(50);
  });

  it('parses --limit <n> (space form)', () => {
    expect(parseLimit(['--limit', '50'])).toBe(50);
  });

  it('defaults silently when --limit is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLimit([])).toBe(DEFAULT_LIMIT);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and falls back on a non-numeric value (--limit=abc)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLimit(['--limit=abc'])).toBe(DEFAULT_LIMIT);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns and falls back on zero and negative values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLimit(['--limit=0'])).toBe(DEFAULT_LIMIT);
    expect(parseLimit(['--limit', '-5'])).toBe(DEFAULT_LIMIT);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // Round-2 OCR: was silently accepted via Number(raw) (7.9 -> floored to 7).
  // A fractional --limit is an operator typo, not a value to silently truncate.
  it('rejects a fractional value (--limit=7.9)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLimit(['--limit=7.9'])).toBe(DEFAULT_LIMIT);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Round-2 OCR: was silently accepted via Number(raw) (0x10 -> 16).
  it('rejects hex notation (--limit=0x10)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLimit(['--limit=0x10'])).toBe(DEFAULT_LIMIT);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Round-2 OCR: was silently accepted via Number(raw) (1e2 -> 100).
  it('rejects scientific notation (--limit=1e2)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLimit(['--limit=1e2'])).toBe(DEFAULT_LIMIT);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Round-2 OCR: Number('12abc') is NaN so this already warned, but the
  // strict-digit guard pins it explicitly alongside the other rejected forms.
  it('rejects trailing garbage (--limit=12abc)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseLimit(['--limit=12abc'])).toBe(DEFAULT_LIMIT);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('accepts a plain decimal integer with no truncation', () => {
    expect(parseLimit(['--limit=100'])).toBe(100);
  });
});
