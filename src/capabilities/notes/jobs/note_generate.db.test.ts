import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { artifact, event } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type RunTaskFn, runNoteGenerate } from './note_generate';

const ATOMIC = `NOTE v1
@type note_atomic

@definition
椭圆

@mechanism
机制

@example
例子

@pitfall
易错

@check
自检
@end
`;

const LONG = `NOTE v1
@type note_long

@body
离心率沿用定义。
@end
`;

async function seedPending(id: string, type: 'note_atomic' | 'note_long'): Promise<void> {
  const now = new Date();
  await testDb().insert(artifact).values({
    id,
    type,
    title: id,
    parent_artifact_id: null,
    knowledge_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    body_blocks: null,
    attrs: {},
    tool_kind: null,
    tool_state: null,
    generation_status: 'pending',
    verification_status: 'not_required',
    generated_by: null,
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function fakeRun(text: string, finishReason: string, taskRunId: string): RunTaskFn {
  return async (_kind, _input, ctx) => {
    await ctx?.beforeProviderQuery?.({
      taskRunId,
      provider: 'anthropic-sub',
      model: 'test',
    });
    return { text, finishReason, task_run_id: taskRunId };
  };
}

async function generationStatus(db: Db, id: string): Promise<string | undefined> {
  const rows = await db
    .select({ status: artifact.generation_status })
    .from(artifact)
    .where(eq(artifact.id, id))
    .limit(1);
  return rows[0]?.status;
}

describe('runNoteGenerate stop reason', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant data: a note generation stopped for length is not stored ready, and the failure event points at that task run
  // @fails-if runNoteGenerate ignores finishReason, so a complete note with max_tokens becomes ready, or the failed lifecycle event omits task_run_id
  it('fails a complete note stopped for length and records the task run', async () => {
    await seedPending('yuk-981-cut', 'note_atomic');
    await seedPending('yuk-981-done', 'note_long');
    const db = testDb();

    await expect(
      runNoteGenerate({
        db,
        artifactId: 'yuk-981-cut',
        runTaskFn: fakeRun(ATOMIC, 'max_tokens', 'run-981'),
      }),
    ).rejects.toThrow(/max_tokens/);
    expect(await generationStatus(db, 'yuk-981-cut')).toBe('failed');

    const events = await db
      .select({ taskRunId: event.task_run_id })
      .from(event)
      .where(
        and(
          eq(event.subject_id, 'yuk-981-cut'),
          eq(event.action, 'experimental:artifact_lifecycle'),
        ),
      );
    expect(events).toContainEqual({ taskRunId: 'run-981' });

    await expect(
      runNoteGenerate({
        db,
        artifactId: 'yuk-981-done',
        runTaskFn: fakeRun(LONG, 'end_turn', 'run-982'),
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(await generationStatus(db, 'yuk-981-done')).toBe('ready');
  });
});
