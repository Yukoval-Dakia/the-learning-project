import { artifact } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { MAX_NOTE_REFINE_FANOUT, collectMasteryRefineTargets } from './note-refine-targets';

async function seedNote(id: string, knowledgeId: string, createdAt: Date): Promise<void> {
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'note_atomic',
      title: id,
      knowledge_ids: [knowledgeId],
      generation_status: 'ready',
      intent_source: 'test',
      source: 'test',
      verification_status: 'not_required',
      created_at: createdAt,
      updated_at: createdAt,
    });
}

describe('collectMasteryRefineTargets (YUK-694)', () => {
  beforeEach(() => resetDb());

  it('includes source_ref, deduplicates labels, and caps one attempt at eight jobs', async () => {
    for (let i = 0; i < MAX_NOTE_REFINE_FANOUT + 5; i++) {
      await seedNote(`note_${i}`, 'kc_many', new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }

    const targets = await collectMasteryRefineTargets(testDb(), 'source_note', [
      'kc_many',
      'kc_many',
    ]);

    expect(targets).toHaveLength(MAX_NOTE_REFINE_FANOUT);
    expect(targets[0]).toBe('source_note');
    expect(new Set(targets).size).toBe(MAX_NOTE_REFINE_FANOUT);
  });
});
