import { describe, expect, it, vi } from 'vitest';

// The manifest's route/job/tool loads are lazy thunks, so importing the manifest
// object is cheap — but guard against any transitive eager @/db/client import so
// this stays a no-DB unit test.
vi.mock('@/db/client', () => ({ db: {} }));

import { notesCapability } from './manifest';

describe('notes capability — hub-sync job family (YUK-384)', () => {
  const handlers = notesCapability.jobs?.handlers ?? [];
  const byName = new Map(handlers.map((h) => [h.name, h]));

  it('registers the nightly coverage-repair sweep at 02:45 Asia/Shanghai', () => {
    const nightly = byName.get('hub_auto_sync_nightly');
    expect(nightly).toBeDefined();
    expect(nightly?.schedule).toEqual({ cron: '45 2 * * *', tz: 'Asia/Shanghai' });
    expect(nightly?.load).toBeInstanceOf(Function);
  });

  it('registers the every-minute recovery floor', () => {
    const recovery = byName.get('hub_sync_recovery');
    expect(recovery).toBeDefined();
    expect(recovery?.schedule).toEqual({ cron: '* * * * *', tz: 'Asia/Shanghai' });
    expect(recovery?.load).toBeInstanceOf(Function);
  });

  it('registers the on-demand mutation-wake queue (no cron)', () => {
    const wake = byName.get('hub_sync_mutation_wake');
    expect(wake).toBeDefined();
    expect(wake?.schedule).toBeUndefined();
  });

  it('registers all three hub-sync job-family members', () => {
    for (const name of ['hub_auto_sync_nightly', 'hub_sync_recovery', 'hub_sync_mutation_wake']) {
      expect(byName.has(name)).toBe(true);
    }
  });
});
