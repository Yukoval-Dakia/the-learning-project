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
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '覆盖代词用法核心要点' }],
        required_points: ['说明「之」作代词', '说明它指代前文提及的人、事、物'],
      },
    },
    {
      kind: 'choice',
      prompt_md: '下列句中「之」属于哪种用法？',
      reference_md: '助词',
      choices_md: ['助词', '代词', '动词'],
      judge_kind_override: 'exact',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '选择正确选项' }],
      },
    },
  ],
});

const PROSE_WITHOUT_CONTRACT_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '请解释「之」作代词时的用法。',
      reference_md: '「之」作代词时，指代前文提及的人、事、物。',
      choices_md: null,
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
  updatedAt?: Date;
}) {
  const db = testDb();
  const now = new Date();
  const updatedAt = opts.updatedAt ?? now;
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
    updated_at: updatedAt,
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
    expect(questions[0].judge_kind_override).toBe('semantic');
    expect(questions[0].rubric_json).toMatchObject({
      required_points: ['说明「之」作代词', '说明它指代前文提及的人、事、物'],
    });
    expect(questions[1].judge_kind_override).toBe('exact');

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

  it('reclaims stale pending embedded_check_status after 30 minutes', async () => {
    await seedAtomic({
      artifactId: 'a1',
      embeddedCheckStatus: 'pending',
      updatedAt: new Date(Date.now() - 31 * 60 * 1000),
    });
    const runTaskFn = vi.fn(async () => ({ text: VALID_OUTPUT }));

    const result = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result.status).toBe('ready');
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  // Regression for PR #76 review P3: when stale-pending reclaim fires, the
  // original (slow) handler's eventual commit must not leave orphan question
  // rows pointing to the artifact while the artifact references a different
  // question_ids set written by the reclaiming handler.
  //
  // After the optimistic-lock fix, the slow handler's claim attempt will be
  // refused (artifact status is already 'ready'), so it can never insert
  // orphan rows. This test pins that post-condition.
  it('stale-pending reclaim does not leave orphan question rows', async () => {
    const PENDING_STALE_MS = 30 * 60 * 1000;
    const stalePendingAt = new Date(Date.now() - PENDING_STALE_MS - 60_000);
    await seedAtomic({
      artifactId: 'a-race',
      knowledgeId: 'k-race',
      embeddedCheckStatus: 'pending',
      updatedAt: stalePendingAt,
    });

    // The reclaiming handler runs to completion first, advancing updated_at
    // and writing its 1 question row.
    const reclaimRunTask = vi.fn(async () => ({
      text: JSON.stringify({
        questions: [
          {
            kind: 'short_answer',
            prompt_md: 'reclaim Q1',
            reference_md: 'reclaim A1',
            choices_md: null,
            judge_kind_override: 'semantic',
            rubric_json: {
              criteria: [{ name: 'correctness', weight: 1, descriptor: 'core point' }],
              required_points: ['point'],
            },
          },
        ],
      }),
    }));
    const reclaimResult = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a-race',
      runTaskFn: reclaimRunTask,
    });
    expect(reclaimResult.status).toBe('ready');

    // The "slow" original handler now tries to commit its own work. Because
    // the artifact is no longer in a claimable status, the call returns a
    // skip outcome and inserts nothing. Either skip outcome is acceptable
    // — both prove no orphan rows can be written.
    const slowRunTask = vi.fn(async () => ({
      text: JSON.stringify({
        questions: [
          {
            kind: 'short_answer',
            prompt_md: 'slow Q1',
            reference_md: 'slow A1',
            choices_md: null,
            judge_kind_override: 'semantic',
            rubric_json: {
              criteria: [{ name: 'correctness', weight: 1, descriptor: 'core point' }],
              required_points: ['point'],
            },
          },
        ],
      }),
    }));
    const slowResult = await runEmbeddedCheckGenerate({
      db: testDb(),
      artifactId: 'a-race',
      runTaskFn: slowRunTask,
    });
    expect(['skipped:already_in_progress', 'skipped:already_ready']).toContain(slowResult.status);

    // The artifact must reference exactly the reclaim handler's question ids.
    const [finalArtifact] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, 'a-race'));
    expect(finalArtifact.embedded_check_status).toBe('ready');
    const finalSections = finalArtifact.sections as Array<{
      kind: string;
      embedded_check?: { question_ids: string[] } | null;
    }>;
    const checkSection = finalSections.find((s) => s.kind === 'check');
    expect(checkSection?.embedded_check?.question_ids).toEqual(reclaimResult.question_ids);

    // And the question table must contain ONLY the reclaim's row — no orphans.
    const questions = await testDb()
      .select()
      .from(question)
      .where(eq(question.source_ref, 'a-race'));
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt_md).toBe('reclaim Q1');
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

  // Regression for PR #76 review P1: if any future prompt drift makes the AI
  // emit subject-level kinds (single_choice / reading_comprehension /
  // calculation / proof / word_problem), the handler must mark the artifact
  // as 'failed' rather than silently writing rows with an invalid kind.
  // This is the contract that protects downstream judges + UI from kind
  // values they cannot interpret.
  it('rejects AI output that uses subject-level kinds; artifact ends in failed state', async () => {
    await seedAtomic({ artifactId: 'a-reject', knowledgeId: 'k-reject' });
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        questions: [
          {
            kind: 'single_choice', // subject-only — must be rejected
            prompt_md: '「之」作代词时指代什么？',
            reference_md: '前文提及的人、事、物。',
            choices_md: ['前文提及的人事物', '助词', '动词', '介词'],
            judge_kind_override: 'exact',
            rubric_json: null,
          },
        ],
      }),
    }));

    await expect(
      runEmbeddedCheckGenerate({ db: testDb(), artifactId: 'a-reject', runTaskFn }),
    ).rejects.toThrow(/schema invalid/i);

    // The artifact status must be 'failed' (set by the catch block before re-throwing).
    const [updated] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, 'a-reject'));
    expect(updated.embedded_check_status).toBe('failed');

    // No question rows should have been inserted.
    const questions = await testDb()
      .select()
      .from(question)
      .where(eq(question.source_ref, 'a-reject'));
    expect(questions).toHaveLength(0);

    // A failure event should have been written.
    const events = await testDb().select().from(event).where(eq(event.subject_id, 'a-reject'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure');
    expect(events[0].action).toBe('experimental:embedded_check_generate');
  });

  it('rejects prose questions without semantic judge contract', async () => {
    await seedAtomic({ artifactId: 'a1' });
    const runTaskFn = vi.fn(async () => ({ text: PROSE_WITHOUT_CONTRACT_OUTPUT }));

    await expect(
      runEmbeddedCheckGenerate({
        db: testDb(),
        artifactId: 'a1',
        runTaskFn,
      }),
    ).rejects.toThrow(/semantic judge without required_points|cannot use exact judge/);

    const [updatedArtifact] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updatedArtifact.embedded_check_status).toBe('failed');
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
