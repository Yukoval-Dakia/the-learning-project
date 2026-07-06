// YUK-379 (OCR #2) — parseLimit CLI arg parsing.

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

  it('floors a fractional value', () => {
    expect(parseLimit(['--limit=7.9'])).toBe(7);
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
});
