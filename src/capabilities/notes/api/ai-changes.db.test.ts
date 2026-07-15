import { beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactAiChangesResponseSchema,
  RecentArtifactAiChangesResponseSchema,
  UndoArtifactAiChangeResponseSchema,
} from '@/capabilities/notes/api/contracts';
import { persistNoteRefineApply } from '@/capabilities/notes/server/note-refine-apply';
import { artifact } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as undoChange } from './ai-change-undo';
import { GET as getArtifactChanges } from './ai-changes';
import { GET as getRecentChanges } from './ai-changes-recent';

async function seedArtifact(id: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'note_atomic',
      title: 'Contract test note',
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: { type: 'doc', content: [] },
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

async function applyChange(artifactId: string): Promise<string> {
  const result = await persistNoteRefineApply({
    db: testDb(),
    artifactId,
    patch: {
      ops: [
        {
          kind: 'append_block',
          block: {
            type: 'semanticBlock',
            attrs: { id: 'generated_block', semantic_kind: 'definition' },
            content: [],
          },
        },
      ],
    },
  });
  expect(result.status).toBe('applied');
  if (!result.event_id) throw new Error('apply event id missing');
  return result.event_id;
}

describe('artifact AI change route contracts', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('validates artifact-scoped and recent list responses', async () => {
    await seedArtifact('note_ai_changes');
    await applyChange('note_ai_changes');

    const artifactResponse = await getArtifactChanges(
      new Request('http://localhost/api/artifacts/note_ai_changes/ai-changes'),
      { id: 'note_ai_changes' },
    );
    expect(artifactResponse.status).toBe(200);
    const artifactBody = ArtifactAiChangesResponseSchema.parse(await artifactResponse.json());
    expect(artifactBody.rows).toHaveLength(1);

    const recentResponse = await getRecentChanges();
    expect(recentResponse.status).toBe(200);
    const recentBody = RecentArtifactAiChangesResponseSchema.parse(await recentResponse.json());
    expect(recentBody.rows.map((row) => row.artifact_id)).toContain('note_ai_changes');
  });

  it('validates undo and idempotent retry responses', async () => {
    await seedArtifact('note_ai_undo');
    const eventId = await applyChange('note_ai_undo');
    const params = { id: 'note_ai_undo', eventId };
    const request = new Request(
      `http://localhost/api/artifacts/note_ai_undo/ai-changes/${eventId}/undo`,
      { method: 'POST' },
    );

    const first = await undoChange(request, params);
    expect(first.status).toBe(200);
    expect(UndoArtifactAiChangeResponseSchema.parse(await first.json()).status).toBe('undone');

    const second = await undoChange(request, params);
    expect(second.status).toBe(200);
    expect(UndoArtifactAiChangeResponseSchema.parse(await second.json()).status).toBe(
      'skipped:already_undone',
    );
  });
});
