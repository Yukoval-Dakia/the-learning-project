import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { artifact, event } from '@/db/schema';
import {
  NOTE_HANDOFF_KINDS,
  noteHandoffEventId,
  writeNoteGenerationIntent,
} from '@/kernel/records/note-handoff-protocol';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { dispatchNoteGeneration } from './note-handoff';

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
