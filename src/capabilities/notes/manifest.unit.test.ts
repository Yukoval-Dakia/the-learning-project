import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { notesTaskSpecs } from './tasks';

// The manifest's route/job/tool loads are lazy thunks, so importing the manifest
// object is cheap — but guard against any transitive eager @/db/client import so
// this stays a no-DB unit test.
vi.mock('@/db/client', () => ({ db: {} }));

import { notesCapability } from './manifest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('notes capability — semantic ownership (YUK-875)', () => {
  it('owns NoteRefineTask without a central semantic definition', () => {
    expect(notesTaskSpecs.NoteRefineTask.ownership).toBe('owned');

    // YUK-885 — the central quarry file is deleted entirely.
    expect(existsSync(join(process.cwd(), 'src/ai/legacy-task-definitions.ts'))).toBe(false);
  });

  it('owns editing-session and mutation-event implementations under Notes', () => {
    for (const path of [
      'src/capabilities/notes/server/artifacts/editing-session.ts',
      'src/capabilities/notes/server/artifacts/mutation-events.ts',
    ]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
    for (const path of [
      'src/server/artifacts/editing-session.ts',
      'src/server/artifacts/mutation-events.ts',
    ]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(false);
    }
  });

  it('keeps the shared create envelope free of Notes mutation semantics', () => {
    const createEnvelope = source('src/server/artifacts/create-event.ts');
    expect(createEnvelope).not.toContain('experimental:body_blocks_edit');
    expect(createEnvelope).not.toContain('experimental:artifact_lifecycle');
    expect(createEnvelope).not.toContain('NotePatch');
  });
});

describe('notes capability — copilot tools and correction read model (YUK-880)', () => {
  it('declares author_artifact + update_artifact with lazy loads that resolve to the tools', async () => {
    const tools = notesCapability.copilotTools?.tools ?? [];
    for (const name of ['author_artifact', 'update_artifact']) {
      const matches = tools.filter((tool) => tool.name === name);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.load).toBeInstanceOf(Function);
      const resolved = await matches[0]?.load?.();
      expect((resolved as { name: string }).name).toBe(name);
    }
  });

  it('owns both tool implementations and the artifact-correction read model under Notes', () => {
    for (const path of [
      'src/capabilities/notes/server/tools/author-artifact.ts',
      'src/capabilities/notes/server/artifact-corrections.ts',
    ]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
    for (const path of [
      'src/server/ai/tools/author-artifact.ts',
      'src/server/events/artifact-corrections.ts',
      'src/server/ai/tools/author-artifact.test.ts',
      'src/server/events/artifact-corrections.test.ts',
    ]) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(false);
    }
  });

  it('rejects Copilot as the implementation owner of the artifact authoring tools', () => {
    const copilotManifest = source('src/capabilities/copilot/manifest.ts');
    expect(copilotManifest).not.toContain("import('@/server/ai/tools/author-artifact')");
    expect(copilotManifest).not.toContain("'author_artifact'");
    expect(copilotManifest).not.toContain("'update_artifact'");

    // Surface allowlist names stay (permissions unchanged) — only the
    // implementation ownership moved.
    const allowlists = source('src/server/ai/tools/allowlists.ts');
    expect(allowlists).toContain("'author_artifact'");
    expect(allowlists).toContain("'update_artifact'");
  });
});

describe('notes capability — mastery progress subscription (YUK-751)', () => {
  it('declares the exact live versioned identity and keeps its loader lazy', async () => {
    const subscription = notesCapability.subscriptions?.handlers[0];
    expect(notesCapability.subscriptions?.handlers).toHaveLength(1);
    expect(subscription).toMatchObject({
      id: 'notes.mastery-progress-note-refine',
      version: 1,
      actions: ['experimental:mastery_progress'],
    });
    expect(subscription?.load).toBeInstanceOf(Function);

    const factory = await subscription?.load();
    expect(factory).toBeInstanceOf(Function);
    const handler = factory?.({});
    expect(handler).toBeInstanceOf(Function);
  });
});

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
    expect(byName.has('note_handoff_recovery')).toBe(false);
  });

  it('registers the on-demand mutation-wake queue with a consumer (no cron)', () => {
    const wake = byName.get('hub_sync_mutation_wake');
    expect(wake).toBeDefined();
    expect(wake?.schedule).toBeUndefined();
    // The queue MUST have a load handler — a produced wake with no consumer would
    // be an inert dead queue, silently degrading immediacy to the recovery cron.
    expect(wake?.load).toBeInstanceOf(Function);
  });

  it('registers all three hub-sync job-family members', () => {
    for (const name of ['hub_auto_sync_nightly', 'hub_sync_recovery', 'hub_sync_mutation_wake']) {
      expect(byName.has(name)).toBe(true);
    }
  });
});

describe('notes capability — durable generate and verify handoff (YUK-857)', () => {
  const handlers = notesCapability.jobs?.handlers ?? [];

  it('declares exactly one loadable handler for each Notes handoff queue', async () => {
    for (const name of ['note_generate', 'note_verify']) {
      const matches = handlers.filter((handler) => handler.name === name);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.load).toBeInstanceOf(Function);
      await expect(matches[0]?.load?.()).resolves.toBeInstanceOf(Function);
    }
  });

  it('keeps queue tiers exact and uses the shared Notes recovery floor', () => {
    const generate = handlers.find((handler) => handler.name === 'note_generate');
    const verify = handlers.find((handler) => handler.name === 'note_verify');
    expect(generate).toMatchObject({ queue: 'llm' });
    expect(generate?.schedule).toBeUndefined();
    expect(verify).toMatchObject({ queue: 'llm' });
    expect(verify?.schedule).toBeUndefined();
    expect(handlers.find((handler) => handler.name === 'note_handoff_recovery')).toBeUndefined();
    expect(handlers.find((handler) => handler.name === 'hub_sync_recovery')).toMatchObject({
      queue: 'llm',
      schedule: { cron: '* * * * *', tz: 'Asia/Shanghai' },
    });
  });
});
