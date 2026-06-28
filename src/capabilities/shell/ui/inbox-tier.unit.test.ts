import { describe, expect, it } from 'vitest';

import {
  UNDO_WINDOW_MS,
  autoAppliedState,
  bucketPendingByTier,
  isMovedOutKind,
  undoRemainingMs,
} from './inbox-tier';

// YUK-521 (A4 强度轴) — pure tier-split + undo-window state. Mirrors the
// effectiveness-trend-view.unit范式: no DB / no React, locks the boundaries.

describe('isMovedOutKind (C-strength = no accept applier)', () => {
  it('the three observe-only kinds are moved-out', () => {
    expect(isMovedOutKind('defer')).toBe(true);
    expect(isMovedOutKind('archive')).toBe(true);
    expect(isMovedOutKind('judge_retraction')).toBe(true);
  });

  it('B-strength kinds and the A-strength completion are NOT moved-out', () => {
    expect(isMovedOutKind('note_update')).toBe(false);
    expect(isMovedOutKind('knowledge_edge')).toBe(false);
    expect(isMovedOutKind('completion')).toBe(false);
    // LEGACY tombstones are B, never folded into the C block.
    expect(isMovedOutKind('record_links')).toBe(false);
    expect(isMovedOutKind('record_promotion')).toBe(false);
  });

  it('an unknown kind falls to the decide block, never silently hidden', () => {
    expect(isMovedOutKind('totally_new_kind')).toBe(false);
  });
});

describe('bucketPendingByTier', () => {
  it('splits C-strength into moved, everything else into decide', () => {
    const rows = [
      { id: '1', kind: 'knowledge_edge' },
      { id: '2', kind: 'defer' },
      { id: '3', kind: 'completion' }, // breaker-fallback completion → decide
      { id: '4', kind: 'archive' },
      { id: '5', kind: 'note_update' },
      { id: '6', kind: 'judge_retraction' },
    ];
    const { decide, moved } = bucketPendingByTier(rows);
    expect(decide.map((r) => r.id)).toEqual(['1', '3', '5']);
    expect(moved.map((r) => r.id)).toEqual(['2', '4', '6']);
  });

  it('handles empty input', () => {
    expect(bucketPendingByTier([])).toEqual({ decide: [], moved: [] });
  });
});

describe('autoAppliedState', () => {
  const base = 1_000_000;

  it('reverted wins regardless of window', () => {
    expect(autoAppliedState(base, base, true)).toBe('reverted');
    expect(autoAppliedState(base, base + UNDO_WINDOW_MS * 5, true)).toBe('reverted');
  });

  it('within the window → live', () => {
    expect(autoAppliedState(base, base, false)).toBe('live');
    expect(autoAppliedState(base, base + UNDO_WINDOW_MS - 1, false)).toBe('live');
  });

  it('at/after the window edge → consumed', () => {
    expect(autoAppliedState(base, base + UNDO_WINDOW_MS, false)).toBe('consumed');
    expect(autoAppliedState(base, base + UNDO_WINDOW_MS * 10, false)).toBe('consumed');
  });

  it('honors a custom window', () => {
    expect(autoAppliedState(base, base + 500, false, 1000)).toBe('live');
    expect(autoAppliedState(base, base + 1000, false, 1000)).toBe('consumed');
  });
});

describe('undoRemainingMs', () => {
  const base = 1_000_000;
  it('counts down inside the window and floors at 0', () => {
    expect(undoRemainingMs(base, base)).toBe(UNDO_WINDOW_MS);
    expect(undoRemainingMs(base, base + UNDO_WINDOW_MS - 1000)).toBe(1000);
    expect(undoRemainingMs(base, base + UNDO_WINDOW_MS)).toBe(0);
    expect(undoRemainingMs(base, base + UNDO_WINDOW_MS * 3)).toBe(0);
  });
});
