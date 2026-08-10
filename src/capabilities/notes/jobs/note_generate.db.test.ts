import { bodyBlocksToNoteSections } from '@/capabilities/notes/server/body-blocks';
import { artifact, event, knowledge } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type RunTaskFn, buildNoteGenerateHandler, runNoteGenerate } from './note_generate';

async function seedAtomic(opts: {
  artifactId: string;
  pending?: boolean;
  archived?: boolean;
  knowledgeId?: string;
  domain?: string | null;
}) {
  const db = testDb();
  const now = new Date();
  if (opts.knowledgeId) {
    await db.insert(knowledge).values({
      id: opts.knowledgeId,
      name: '之',
      domain: opts.domain ?? 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
  await db.insert(artifact).values({
    id: opts.artifactId,
    type: 'note_atomic',
    title: '之的用法',
    parent_artifact_id: null,
    knowledge_ids: opts.knowledgeId ? [opts.knowledgeId] : [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    body_blocks: null,
    attrs: { one_line_intent: '区分「之」三种用法' } as never,
    tool_kind: null,
    tool_state: null,
    generation_status: opts.pending === false ? 'ready' : 'pending',
    generated_by: null,
    history: [],
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

const VALID_SECTIONS = JSON.stringify({
  sections: [
    {
      id: 's1',
      kind: 'definition',
      body_md: '「之」是文言虚词。',
      source_tier: 'llm_only',
      user_verified: false,
      embedded_check: null,
      version: 1,
    },
    {
      id: 's2',
      kind: 'mechanism',
      body_md: '助词 / 代词 / 动词三类。',
      source_tier: 'llm_only',
      user_verified: false,
      embedded_check: null,
      version: 1,
    },
    {
      id: 's3',
      kind: 'example',
      body_md: '例：师道之不传也久矣。',
      source_tier: 'llm_only',
      user_verified: false,
      embedded_check: null,
      version: 1,
    },
    {
      id: 's4',
      kind: 'pitfall',
      body_md: '主谓间「之」无义。',
      source_tier: 'llm_only',
      user_verified: false,
      embedded_check: null,
      version: 1,
    },
    {
      id: 's5',
      kind: 'check',
      body_md: '自检 2 题',
      source_tier: 'llm_only',
      user_verified: false,
      embedded_check: { question_ids: [] },
      version: 1,
    },
  ],
});

describe('runNoteGenerate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns skipped:not_found when artifact does not exist', async () => {
    const runTaskFn = vi.fn();
    const result = await runNoteGenerate({
      db: testDb(),
      artifactId: 'a_nope',
      runTaskFn,
    });
    expect(result.status).toBe('skipped:not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:not_pending when artifact is already ready', async () => {
    await seedAtomic({ artifactId: 'a1', pending: false });
    const runTaskFn = vi.fn();
    const result = await runNoteGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });
    expect(result.status).toBe('skipped:not_pending');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('skips an archived pending delivery before invoking the task runner', async () => {
    await seedAtomic({ artifactId: 'archived-pending', archived: true });
    const runTaskFn = vi.fn();

    await expect(
      runNoteGenerate({ db: testDb(), artifactId: 'archived-pending', runTaskFn }),
    ).resolves.toMatchObject({ status: 'skipped:not_pending' });

    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('does not submit a provider query when the artifact is archived at the boundary', async () => {
    await seedAtomic({ artifactId: 'archived-at-boundary' });
    const db = testDb();
    let providerQueries = 0;
    const runTaskFn: RunTaskFn = vi.fn(async (_kind, _input, ctx) => {
      await db
        .update(artifact)
        .set({ archived_at: new Date(), updated_at: new Date() })
        .where(eq(artifact.id, 'archived-at-boundary'));
      if (!ctx?.beforeProviderQuery) throw new Error('provider boundary callback missing');
      await ctx.beforeProviderQuery({
        taskRunId: 'generate-archive-race',
        provider: 'anthropic-sub',
        model: 'test',
      });
      providerQueries += 1;
      return { text: VALID_SECTIONS };
    });

    await expect(
      runNoteGenerate({ db, artifactId: 'archived-at-boundary', runTaskFn }),
    ).rejects.toThrow('note generation is no longer pending and active');

    expect(providerQueries).toBe(0);
    const [row] = await db
      .select({ status: artifact.generation_status, archivedAt: artifact.archived_at })
      .from(artifact)
      .where(eq(artifact.id, 'archived-at-boundary'));
    expect(row).toMatchObject({ status: 'pending' });
    expect(row.archivedAt).not.toBeNull();
  });

  it('generates + writes sections on happy path', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_SECTIONS,
      task_run_id: 'tr_note_generate_1',
    }));
    const result = await runNoteGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });
    expect(result.status).toBe('ready');
    expect(result.sections_count).toBe(5);

    const db = testDb();
    const updated = (await db.select().from(artifact).where(eq(artifact.id, 'a1')))[0];
    expect(updated.generation_status).toBe('ready');
    expect(updated.verification_status).toBe('queued');
    const sections = bodyBlocksToNoteSections(updated.body_blocks);
    expect(sections).toHaveLength(5);
    expect(sections[0].kind).toBe('definition');
    expect((updated.generated_by as { task_run_id?: string } | null)?.task_run_id).toBe(
      'tr_note_generate_1',
    );
    const verificationIntents = await testDb()
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:note_handoff'));
    expect(verificationIntents).toHaveLength(1);
    expect(verificationIntents[0]?.payload).toMatchObject({
      version: 1,
      artifact_id: 'a1',
      handoff_kind: 'verification_intent',
    });
  });

  it('buildNoteGenerateHandler dispatches verification after the ready transaction commits', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_SECTIONS,
    }));
    const dispatchVerification = vi.fn(async (_artifactId: string) => true);
    const handler = buildNoteGenerateHandler(testDb(), { runTaskFn, dispatchVerification });

    await handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never]);

    expect(dispatchVerification).toHaveBeenCalledWith('a1');
  });

  it('does not dispatch verification when another worker already claimed the pending artifact', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const db = testDb();
    const runTaskFn = vi.fn(async () => {
      await db
        .update(artifact)
        .set({ generation_status: 'ready', updated_at: new Date() })
        .where(eq(artifact.id, 'a1'));
      return { text: VALID_SECTIONS };
    });
    const dispatchVerification = vi.fn(async (_artifactId: string) => true);
    const handler = buildNoteGenerateHandler(db, { runTaskFn, dispatchVerification });

    await handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never]);

    expect(dispatchVerification).not.toHaveBeenCalled();
  });

  it('passes the knowledge subject profile to NoteGenerateTask', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k_math', domain: 'math' });
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_SECTIONS,
    }));

    await runNoteGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    const ctx = runTaskFn.mock.calls[0]?.[2] as unknown as {
      subjectProfile?: { id: string };
      skills?: string[];
    };
    expect(ctx.subjectProfile?.id).toBe('math');
    // YUK-228 (S3 Slice B): handler must pass resolveNoteSkill(subject) as skills.
    // YUK-611: resolver 输出命名空间名（== populate 镜像键）。
    expect(ctx.skills).toEqual(['math--note-math']);
  });

  it('marks generation_status=failed when LLM throws (and rethrows)', async () => {
    await seedAtomic({ artifactId: 'a1' });
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => {
      throw new Error('mimo down');
    });
    await expect(runNoteGenerate({ db: testDb(), artifactId: 'a1', runTaskFn })).rejects.toThrow(
      'mimo down',
    );

    const db = testDb();
    const updated = (await db.select().from(artifact).where(eq(artifact.id, 'a1')))[0];
    expect(updated.generation_status).toBe('failed');
  });

  it('reruns a failed delivery, then skips completed redelivery without another provider call', async () => {
    await seedAtomic({ artifactId: 'retry-success' });
    let calls = 0;
    const runTaskFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient generation failure');
      return { text: VALID_SECTIONS };
    });
    const dispatchVerification = vi.fn(async () => true);
    const handler = buildNoteGenerateHandler(testDb(), { runTaskFn, dispatchVerification });

    await expect(
      handler([{ id: 'first-delivery', data: { artifact_id: 'retry-success' } } as never]),
    ).rejects.toThrow('transient generation failure');
    const [failed] = await testDb()
      .select({ status: artifact.generation_status })
      .from(artifact)
      .where(eq(artifact.id, 'retry-success'));
    expect(failed.status).toBe('failed');

    await expect(
      handler([{ id: 'retry-delivery', data: { artifact_id: 'retry-success' } } as never]),
    ).resolves.toBeUndefined();
    await expect(
      handler([{ id: 'completed-redelivery', data: { artifact_id: 'retry-success' } } as never]),
    ).resolves.toBeUndefined();
    const [ready] = await testDb()
      .select({ status: artifact.generation_status })
      .from(artifact)
      .where(eq(artifact.id, 'retry-success'));
    expect(ready.status).toBe('ready');
    expect(runTaskFn).toHaveBeenCalledTimes(2);
    expect(dispatchVerification).toHaveBeenCalledTimes(1);
  });

  it('marks failed when LLM output cannot be parsed', async () => {
    await seedAtomic({ artifactId: 'a1' });
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: 'not json at all',
    }));
    await expect(runNoteGenerate({ db: testDb(), artifactId: 'a1', runTaskFn })).rejects.toThrow(
      /parseNoteGenerateOutput/,
    );

    const db = testDb();
    const updated = (await db.select().from(artifact).where(eq(artifact.id, 'a1')))[0];
    expect(updated.generation_status).toBe('failed');
  });
});
