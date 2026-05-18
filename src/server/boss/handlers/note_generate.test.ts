import { artifact, knowledge } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runNoteGenerate } from './note_generate';

async function seedAtomic(opts: { artifactId: string; pending?: boolean; knowledgeId?: string }) {
  const db = testDb();
  const now = new Date();
  if (opts.knowledgeId) {
    await db.insert(knowledge).values({
      id: opts.knowledgeId,
      name: '之',
      domain: 'wenyan',
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
    knowledge_id: opts.knowledgeId ?? null,
    parent_artifact_id: null,
    child_artifact_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    outline_json: { one_line_intent: '区分「之」三种用法' } as never,
    sections: null,
    tool_kind: null,
    tool_state: null,
    generation_status: opts.pending === false ? 'ready' : 'pending',
    generated_by: null,
    history: [],
    archived_at: null,
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

  it('generates + writes sections on happy path', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_SECTIONS,
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
    expect(updated.sections).toHaveLength(5);
    expect((updated.sections as Array<{ kind: string }>)[0].kind).toBe('definition');

    const ctx = runTaskFn.mock.calls[0]?.[2] as { subjectProfile?: { id: string } };
    expect(ctx.subjectProfile?.id).toBe('wenyan');
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

  it('marks failed when LLM output cannot be parsed', async () => {
    await seedAtomic({ artifactId: 'a1' });
    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: 'not json at all',
    }));
    await expect(runNoteGenerate({ db: testDb(), artifactId: 'a1', runTaskFn })).rejects.toThrow(
      /parseSectionsOutput/,
    );

    const db = testDb();
    const updated = (await db.select().from(artifact).where(eq(artifact.id, 'a1')))[0];
    expect(updated.generation_status).toBe('failed');
  });
});
