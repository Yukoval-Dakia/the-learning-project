import { artifact, event, knowledge, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  buildEmbeddedCheckGenerateHandler,
  runEmbeddedCheckGenerate,
} from './embedded_check_generate';

const NOTE_SECTIONS = [
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
    kind: 'check',
    body_md: '自测题目将在此生成。',
    source_tier: 'llm_only',
    user_verified: false,
    embedded_check: null,
    version: 1,
  },
];

const NO_CHECK_SECTIONS = [
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
];

const VALID_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '请解释「之」作代词时的用法。',
      reference_md: '「之」作代词时，指代前文提及的人、事、物。',
      choices_md: null,
    },
    {
      kind: 'choice',
      prompt_md: '下列句中「之」属于哪种用法？',
      reference_md: '此处「之」是助词，用于主谓之间。',
      choices_md: ['助词', '代词', '动词'],
    },
  ],
});

const ZERO_QUESTIONS_OUTPUT = JSON.stringify({
  questions: [],
});

async function seedAtomic(opts: {
  artifactId: string;
  generationStatus?: string;
  embeddedCheckStatus?: string;
  sections?: unknown[] | null;
  knowledgeId?: string;
  domain?: string | null;
}) {
  const db = testDb();
  const now = new Date();
  if (opts.knowledgeId) {
    await db.insert(knowledge).values({
      id: opts.knowledgeId,
      name: opts.domain === 'math' ? '一元二次方程' : '之',
      domain: opts.domain ?? 'wenyan',
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
    title: opts.domain === 'math' ? '配方法' : '之的用法',
    knowledge_id: opts.knowledgeId ?? null,
    parent_artifact_id: null,
    child_artifact_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    outline_json: { one_line_intent: '区分关键用法' } as never,
    sections: (opts.sections === undefined ? NOTE_SECTIONS : opts.sections) as never,
    tool_kind: null,
    tool_state: null,
    generation_status: opts.generationStatus ?? 'ready',
    verification_status: 'queued',
    verification_summary: null,
    generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' } as never,
    verified_by: null,
    embedded_check_status: opts.embeddedCheckStatus ?? 'not_required',
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('runEmbeddedCheckGenerate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Test 1: Happy path
  it('writes N question rows, updates artifact status=ready, updates check section embedded_check.question_ids, writes success event', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: VALID_OUTPUT }));

    const result = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result.status).toBe('ready');
    expect(result.question_ids).toHaveLength(2);

    // questions inserted with source='embedded'
    const questions = await testDb().select().from(question).where(eq(question.source, 'embedded'));
    expect(questions).toHaveLength(2);
    expect(questions[0].source_ref).toBe('a1');
    expect(questions[0].knowledge_ids).toEqual(['k1']);
    expect(questions[0].difficulty).toBe(2);

    // artifact updated to embedded_check_status='ready'
    const [updatedArtifact] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updatedArtifact.embedded_check_status).toBe('ready');

    // check section updated with question_ids
    const sections = updatedArtifact.sections as Array<{
      id: string;
      kind: string;
      embedded_check?: { question_ids: string[] } | null;
    }>;
    const checkSection = sections.find((s) => s.kind === 'check');
    expect(checkSection?.embedded_check?.question_ids).toEqual(result.question_ids);

    // success event written
    const events = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'experimental:embedded_check_generate',
      subject_kind: 'artifact',
      outcome: 'success',
      actor_ref: 'embedded_check_generate',
    });
    expect(events[0].payload).toMatchObject({
      question_ids: result.question_ids,
    });
  });

  // Test 2: Skipped — artifact not found
  it('returns skipped:not_found when artifact does not exist', async () => {
    const runTaskFn = vi.fn();

    const result = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'missing',
      runTaskFn,
    });

    expect(result.status).toBe('skipped:not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // Test 3: Skipped — artifact not ready
  it('returns skipped:not_ready when generation_status is pending', async () => {
    await seedAtomic({ artifactId: 'a1', generationStatus: 'pending' });
    const runTaskFn = vi.fn();

    const result = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result.status).toBe('skipped:not_ready');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // Test 4: Skipped — no check section
  it('returns skipped:no_check_section when sections have no kind=check', async () => {
    await seedAtomic({ artifactId: 'a1', sections: NO_CHECK_SECTIONS });
    const runTaskFn = vi.fn();

    const result = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result.status).toBe('skipped:no_check_section');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // Test 5: Skipped — already ready (idempotent)
  it('returns skipped:already_in_progress when embedded_check_status is already ready', async () => {
    await seedAtomic({ artifactId: 'a1', embeddedCheckStatus: 'ready' });
    const runTaskFn = vi.fn();

    const result = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result.status).toBe('skipped:already_in_progress');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // Test 5b: Skipped — already pending (pg-boss re-delivery guard)
  it('returns skipped:already_in_progress when embedded_check_status is pending', async () => {
    await seedAtomic({ artifactId: 'a1', embeddedCheckStatus: 'pending' });
    const runTaskFn = vi.fn();

    const result = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result.status).toBe('skipped:already_in_progress');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // Test 6: AI returns 0 questions — Zod rejects (min:1), handler sets failed, writes failure event, throws
  it('sets embedded_check_status=failed, writes failure event, and throws when AI returns 0 questions', async () => {
    await seedAtomic({ artifactId: 'a1' });
    const runTaskFn = vi.fn(async () => ({ text: ZERO_QUESTIONS_OUTPUT }));

    await expect(
      runEmbeddedCheckGenerate({
        db: testDb(),
        artifactId: 'a1',
        runTaskFn,
      }),
    ).rejects.toThrow(/parseOutput/);

    const [updatedArtifact] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updatedArtifact.embedded_check_status).toBe('failed');

    const events = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'experimental:embedded_check_generate',
      outcome: 'failure',
      actor_ref: 'embedded_check_generate',
    });
  });

  // Test 7: AI returns malformed JSON — sets failed, writes failure event, throws
  it('sets embedded_check_status=failed, writes failure event, and throws when AI returns malformed JSON', async () => {
    await seedAtomic({ artifactId: 'a1' });
    const runTaskFn = vi.fn(async () => ({ text: 'not valid json at all' }));

    await expect(
      runEmbeddedCheckGenerate({
        db: testDb(),
        artifactId: 'a1',
        runTaskFn,
      }),
    ).rejects.toThrow(/parseOutput/);

    const [updatedArtifact] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updatedArtifact.embedded_check_status).toBe('failed');

    const events = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'experimental:embedded_check_generate',
      outcome: 'failure',
    });
  });

  // Test 8: Profile drives prompt — math path
  it('passes subjectProfile from knowledge.domain=math to EmbeddedCheckGenerateTask', async () => {
    await seedAtomic({ artifactId: 'a_math', knowledgeId: 'k_math', domain: 'math' });
    const runTaskFn = vi.fn(async () => ({ text: VALID_OUTPUT }));

    await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a_math',
      runTaskFn,
    });

    expect(runTaskFn).toHaveBeenCalledWith(
      'EmbeddedCheckGenerateTask',
      expect.objectContaining({
        artifact_id: 'a_math',
        knowledge_node: expect.objectContaining({ domain: 'math' }),
      }),
      expect.objectContaining({
        subjectProfile: expect.objectContaining({ id: 'math' }),
      }),
    );
  });
});

describe('buildEmbeddedCheckGenerateHandler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Test 9: Handler invokes runner for each job
  it('invokes runEmbeddedCheckGenerate for each job in the batch', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    await seedAtomic({ artifactId: 'a2', knowledgeId: 'k2' });
    const runTaskFn = vi.fn(async () => ({ text: VALID_OUTPUT }));

    const handler = buildEmbeddedCheckGenerateHandler(testDb(), { runTaskFn });

    const jobs = [
      { id: 'job1', data: { artifact_id: 'a1' } },
      { id: 'job2', data: { artifact_id: 'a2' } },
    ] as never;

    await handler(jobs);

    // Both artifacts should be ready
    const [art1] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    const [art2] = await testDb().select().from(artifact).where(eq(artifact.id, 'a2'));
    expect(art1.embedded_check_status).toBe('ready');
    expect(art2.embedded_check_status).toBe('ready');

    // runTaskFn called twice
    expect(runTaskFn).toHaveBeenCalledTimes(2);
  });
});
