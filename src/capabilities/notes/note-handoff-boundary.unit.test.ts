import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Notes handoff ownership boundary', () => {
  it('removes bespoke registration and direct verify chaining from the generic handler catalog', async () => {
    const source = await readFile(
      new URL('../../server/boss/handlers.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain("createJobQueue(boss, 'note_generate'");
    expect(source).not.toContain("createJobQueue(boss, 'note_verify'");
    expect(source).not.toContain("boss.send('note_verify'");
    expect(source).not.toContain('buildNoteGenerateHandler');
    expect(source).not.toContain('buildNoteVerifyHandler');
  });

  it('removes the legacy onReady callback and agency best-effort send', async () => {
    const [generateSource, applierSource, actionsSource] = await Promise.all([
      readFile(new URL('./jobs/note_generate.ts', import.meta.url), 'utf8'),
      readFile(new URL('../agency/server/proposal-appliers.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../server/proposals/actions.ts', import.meta.url), 'utf8'),
    ]);
    expect(generateSource).not.toContain('onReady');
    expect(applierSource).not.toContain("boss.send(\n    'note_generate'");
    expect(applierSource).not.toContain('NOTE_GENERATE_SINGLETON_SECONDS');
    expect(applierSource).not.toContain('@/capabilities/notes/');
    expect(actionsSource).toContain('dispatchNoteGeneration');
  });

  it('uses hub_sync_recovery as the only scheduled Notes handoff recovery floor', async () => {
    const [manifestSource, recoverySource] = await Promise.all([
      readFile(new URL('./manifest.ts', import.meta.url), 'utf8'),
      readFile(new URL('./jobs/hub_auto_sync_nightly.ts', import.meta.url), 'utf8'),
    ]);
    expect(manifestSource).not.toContain("name: 'note_handoff_recovery'");
    expect(recoverySource).toContain('recoverNoteHandoffsAndClaims');
  });

  it('consolidates Notes production boss access behind its local port', async () => {
    const sources = await Promise.all([
      readFile(new URL('./server/note-handoff.ts', import.meta.url), 'utf8'),
      readFile(new URL('./server/note-refine-triggers.ts', import.meta.url), 'utf8'),
      readFile(new URL('./server/mastery-refine-effect.ts', import.meta.url), 'utf8'),
      readFile(new URL('./server/mastery-progress-subscription.ts', import.meta.url), 'utf8'),
      readFile(new URL('./jobs/hub_auto_sync_nightly.ts', import.meta.url), 'utf8'),
    ]);
    for (const source of sources) expect(source).not.toContain("from '@/server/boss/");
    const port = await readFile(new URL('./server/boss-port.ts', import.meta.url), 'utf8');
    expect(port).toContain("from '@/server/boss/client'");
    expect(port).toContain("from '@/server/boss/pg-boss-drizzle'");
  });
});
