// Unit test for NoteReader 作者/版本 actor 派生 (src/ui/lib/note-actor.ts).
// Pure TS, no DB — lives in the unit partition. Locks the contract the
// NoteReader Context rail + version timeline depend on (empty-history → null
// author, latest-entry author selection, Date-vs-ISO-string `at`, actor
// label/icon mapping incl. the loose catchall + unknown fallback).

import type { ArtifactHistoryEntryT } from '@/core/schema/business';
import { describe, expect, it } from 'vitest';
import { ACTOR_ICON, deriveNoteActorView } from './note-actor';

// History arrives JSON-deserialized in the browser (at: ISO string), but the
// schema types `at` as Date — deriveNoteActorView is runtime-safe for both, so
// these fixtures cast the loose wire shape to the schema type at the boundary,
// mirroring how the page passes `note.history`.
function hist(entries: Array<Record<string, unknown>>): ArtifactHistoryEntryT[] {
  return entries as unknown as ArtifactHistoryEntryT[];
}

describe('deriveNoteActorView', () => {
  it('returns null author + empty versions for empty / undefined history', () => {
    expect(deriveNoteActorView(undefined)).toEqual({ author: null, versions: [] });
    expect(deriveNoteActorView(hist([]))).toEqual({ author: null, versions: [] });
  });

  it('derives author from the LATEST (last) history entry, keeping write order for versions', () => {
    const view = deriveNoteActorView(
      hist([
        { version: 1, at: '2026-05-01T00:00:00.000Z', by: { by: 'user' } },
        { version: 2, at: '2026-05-02T00:00:00.000Z', by: { by: 'ai' } },
      ]),
    );
    expect(view.author).toEqual({ label: 'AI', icon: 'sparkle' });
    expect(view.versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('emits an ISO string `at` for both ISO-string and Date inputs', () => {
    const iso = '2026-05-01T00:00:00.000Z';
    const fromString = deriveNoteActorView(hist([{ version: 1, at: iso, by: { by: 'user' } }]));
    const fromDate = deriveNoteActorView(
      hist([{ version: 1, at: new Date(iso), by: { by: 'user' } }]),
    );
    expect(fromString.versions[0].at).toBe(iso);
    expect(fromDate.versions[0].at).toBe(iso);
  });

  it('maps known AgentRef.by values to CN labels + loom icon names', () => {
    const view = deriveNoteActorView(
      hist([
        { version: 1, at: '2026-05-01T00:00:00.000Z', by: { by: 'user' } },
        { version: 2, at: '2026-05-02T00:00:00.000Z', by: { by: 'ai' } },
        { version: 3, at: '2026-05-03T00:00:00.000Z', by: { by: 'system' } },
      ]),
    );
    expect(view.versions.map((v) => [v.actorLabel, v.actorIcon])).toEqual([
      ['你', 'user'],
      ['AI', 'sparkle'],
      ['系统', 'moon'],
    ]);
  });

  it('falls back for missing `by` (→ 系统 / user icon) and echoes unknown actor strings', () => {
    const view = deriveNoteActorView(
      hist([
        { version: 1, at: '2026-05-01T00:00:00.000Z' }, // no by, no actor
        { version: 2, at: '2026-05-02T00:00:00.000Z', actor: 'cron' }, // loose catchall actor
        { version: 3, at: '2026-05-03T00:00:00.000Z', actor: 'martian' }, // unknown actor
      ]),
    );
    expect(view.versions[0]).toMatchObject({ actorLabel: '系统', actorIcon: 'user' });
    expect(view.versions[1]).toMatchObject({ actorLabel: '定时任务', actorIcon: 'moon' });
    expect(view.versions[2]).toMatchObject({ actorLabel: 'martian', actorIcon: 'user' });
    // author from the latest (unknown) entry echoes the raw string + default icon.
    expect(view.author).toEqual({ label: 'martian', icon: 'user' });
  });

  it('surfaces summary_md as the version note when present', () => {
    const view = deriveNoteActorView(
      hist([
        { version: 1, at: '2026-05-01T00:00:00.000Z', by: { by: 'ai' }, summary_md: '初稿' },
        { version: 2, at: '2026-05-02T00:00:00.000Z', by: { by: 'user' } },
      ]),
    );
    expect(view.versions[0].note).toBe('初稿');
    expect(view.versions[1].note).toBeUndefined();
  });

  it('exposes the documented actor→icon map', () => {
    expect(ACTOR_ICON).toMatchObject({
      user: 'user',
      ai: 'sparkle',
      agent: 'sparkle',
      system: 'moon',
      cron: 'moon',
    });
  });
});
