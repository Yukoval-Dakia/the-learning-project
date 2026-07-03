// YUK-548 (worklist #5, slice 5) — warnFlipOrder unit tests. The flip-order guardrail must WARN
// (never throw) so a boot-throw can never brick app+worker during a single-entity artifact rollback
// while learning_item is still ON (Lens B M3 — the rollback-deadlock the draft's boot-throw caused).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trackedFlagVector, warnFlipOrder } from './sot-flag';

const LEARNING_ITEM = 'PROJECTION_IS_WRITER_LEARNING_ITEM';
const ARTIFACT = 'PROJECTION_IS_WRITER_ARTIFACT';

describe('warnFlipOrder (YUK-548 component 6) — WARN, never throw', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env[LEARNING_ITEM];
    delete process.env[ARTIFACT];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env[LEARNING_ITEM];
    delete process.env[ARTIFACT];
    vi.restoreAllMocks();
  });

  it('both ON (learning_item + artifact) → no flip-order warn', () => {
    process.env[LEARNING_ITEM] = '1';
    process.env[ARTIFACT] = '1';
    expect(() => warnFlipOrder()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    // still prints the boot flag vector (info), regardless.
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('both OFF → no flip-order warn', () => {
    expect(() => warnFlipOrder()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('only learning_item ON (artifact OFF) → WARN (the reverse-rollback dependency)', () => {
    process.env[LEARNING_ITEM] = '1';
    expect(() => warnFlipOrder()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('learning_item ON while artifact OFF');
  });

  it('only artifact ON (learning_item OFF) → no flip-order warn', () => {
    process.env[ARTIFACT] = '1';
    expect(() => warnFlipOrder()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('trackedFlagVector reflects the per-entity env flags', () => {
    process.env[ARTIFACT] = '1';
    const vec = trackedFlagVector();
    expect(vec.artifact).toBe(true);
    expect(vec.learning_item).toBe(false);
    expect(vec.goal).toBe(false);
    expect(vec['knowledge+knowledge_edge']).toBe(false);
  });
});
