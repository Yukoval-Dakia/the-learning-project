import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type RunTaskFn, buildNoteVerifyHandler, runNoteVerify } from './note_verify';

const SECTIONS = ['definition', 'mechanism', 'example', 'pitfall', 'check'].map((kind, index) => ({
  id: `s${index}`,
  kind,
  body_md: `${kind} content`,
  source_tier: 'llm_only',
  user_verified: false,
  embedded_check: null,
  version: 1,
}));

const PASS_OUTPUT = JSON.stringify({
  verdict: 'pass',
  summary_md: 'verified',
  issues: [],
  confidence: 0.9,
});

async function crossProviderBoundary(ctx: Parameters<RunTaskFn>[2]): Promise<void> {
  if (!ctx?.taskRunId || !ctx.beforeProviderQuery) {
    throw new Error('provider boundary callback missing');
  }
  await ctx.beforeProviderQuery({
    taskRunId: ctx.taskRunId,
    provider: 'anthropic-sub',
    model: 'test',
  });
}

async function seedArtifact(id: string, version = 0, db: Db = testDb()): Promise<void> {
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'note_atomic',
    title: id,
    knowledge_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    body_blocks: noteSectionsToBodyBlocks(SECTIONS as never),
    attrs: {},
    generation_status: 'ready',
    verification_status: 'queued',
    history: [],
    created_at: now,
    updated_at: now,
    version,
  });
}

describe('runNoteVerify durable claim', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fences concurrent delivery to exactly one paid call', async () => {
    await seedArtifact('concurrent');
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      await wait;
      return { text: PASS_OUTPUT };
    });
    const first = runNoteVerify({ db: testDb(), artifactId: 'concurrent', runTaskFn });
    await vi.waitFor(() => expect(runTaskFn).toHaveBeenCalledTimes(1));
    await expect(
      runNoteVerify({ db: testDb(), artifactId: 'concurrent', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:in_progress' });
    release?.();
    await expect(first).resolves.toMatchObject({ status: 'verified' });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('keeps a live duplicate delivery retry-visible at the handler boundary', async () => {
    await seedArtifact('busy-handler');
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await crossProviderBoundary(ctx);
      await wait;
      return { text: PASS_OUTPUT };
    });
    const first = runNoteVerify({ db: testDb(), artifactId: 'busy-handler', runTaskFn });
    await vi.waitFor(() => expect(runTaskFn).toHaveBeenCalledTimes(1));
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn });
    await expect(
      handler([{ id: 'redelivery', data: { artifact_id: 'busy-handler' } } as never]),
    ).rejects.toThrow('retry required');
    release?.();
    await expect(first).resolves.toMatchObject({ status: 'verified' });
  });
});
