import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifact, event } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  NOTE_GENERATION_SINGLETON_SECONDS,
  NOTE_HANDOFF_KINDS,
  dispatchNoteGeneration,
  noteHandoffEventId,
  noteHandoffJobId,
  writeNoteGenerationIntent,
} from './note-handoff';

async function seedNote(
  id: string,
  states: {
    readonly generation: string;
    readonly verification: string;
    readonly archived?: boolean;
    readonly type?: string;
  },
): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: states.type ?? 'note_atomic',
      title: `Durable handoff ${id}`,
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: states.generation === 'ready' ? { type: 'doc', content: [] } : null,
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: states.generation,
      verification_status: states.verification,
      generated_by: null,
      history: [],
      archived_at: states.archived ? now : null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

function fakeBoss() {
  const jobs = new Map<string, { readonly state: string }>();
  const send = vi.fn(
    async (
      _queue: string,
      _data: object,
      options: { id: string; singletonKey?: string; singletonSeconds?: number },
    ) => {
      jobs.set(options.id, { state: 'created' });
      return options.id;
    },
  );
  const getJobById = vi.fn(async (_queue: string, id: string) => jobs.get(id) ?? null);
  return { jobs, send, getJobById };
}

describe('Notes durable handoff', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes completion only after deterministic queue confirmation and is duplicate-safe', async () => {
    await seedNote('note-generation', { generation: 'pending', verification: 'not_required' });
    await testDb().transaction((tx) => writeNoteGenerationIntent(tx, 'note-generation'));
    const boss = fakeBoss();

    await expect(dispatchNoteGeneration(testDb(), 'note-generation', { boss })).resolves.toBe(true);
    await expect(dispatchNoteGeneration(testDb(), 'note-generation', { boss })).resolves.toBe(
      false,
    );

    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(boss.send).toHaveBeenCalledWith(
      'note_generate',
      { artifact_id: 'note-generation' },
      {
        id: noteHandoffJobId(NOTE_HANDOFF_KINDS.generationIntent, 'note-generation'),
        singletonKey: 'note-generation',
        singletonSeconds: NOTE_GENERATION_SINGLETON_SECONDS,
      },
    );
    const completion = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(
        eq(
          event.id,
          noteHandoffEventId(NOTE_HANDOFF_KINDS.generationDispatchComplete, 'note-generation'),
        ),
      );
    expect(completion).toHaveLength(1);
  });

  it('concurrent dispatchers converge on one deterministic job and completion', async () => {
    await seedNote('note-concurrent', { generation: 'pending', verification: 'not_required' });
    await testDb().transaction((tx) => writeNoteGenerationIntent(tx, 'note-concurrent'));
    const boss = fakeBoss();
    const results = await Promise.all([
      dispatchNoteGeneration(testDb(), 'note-concurrent', { boss }),
      dispatchNoteGeneration(testDb(), 'note-concurrent', { boss }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(boss.jobs.size).toBe(1);
    const completions = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(
        eq(
          event.id,
          noteHandoffEventId(NOTE_HANDOFF_KINDS.generationDispatchComplete, 'note-concurrent'),
        ),
      );
    expect(completions).toHaveLength(1);
  });
});
