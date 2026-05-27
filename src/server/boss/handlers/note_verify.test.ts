import { artifact, event, knowledge } from '@/db/schema';
import { noteSectionsToBodyBlocks } from '@/server/artifacts/body-blocks';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { buildNoteVerifyHandler, runNoteVerify } from './note_verify';

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
    kind: 'mechanism',
    body_md: '助词 / 代词 / 动词三类。',
    source_tier: 'llm_only',
    user_verified: false,
    embedded_check: null,
    version: 1,
  },
];

const PASS_OUTPUT = JSON.stringify({
  verdict: 'pass',
  summary_md: '结构完整，未发现明显问题。',
  issues: [],
  confidence: 0.82,
});

const NEEDS_REVIEW_OUTPUT = JSON.stringify({
  verdict: 'needs_review',
  summary_md: '例子部分需要人工复核。',
  issues: [
    {
      section_id: 's2',
      severity: 'warn',
      category: 'factuality',
      message: '例句解释缺少文本证据。',
      suggested_fix_md: '补充原句出处或改成不确定表述。',
    },
  ],
  confidence: 0.58,
});

async function seedAtomic(opts: {
  artifactId: string;
  generationStatus?: string;
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
    parent_artifact_id: null,
    knowledge_ids: opts.knowledgeId ? [opts.knowledgeId] : [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    body_blocks:
      opts.sections === null
        ? null
        : noteSectionsToBodyBlocks(
            (opts.sections === undefined ? NOTE_SECTIONS : opts.sections) as never,
          ),
    attrs: { one_line_intent: '区分关键用法' } as never,
    tool_kind: null,
    tool_state: null,
    generation_status: opts.generationStatus ?? 'ready',
    verification_status: 'queued',
    verification_summary: null,
    generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' } as never,
    verified_by: null,
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('runNoteVerify', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns skipped:not_found when artifact does not exist', async () => {
    const runTaskFn = vi.fn();

    const result = await runNoteVerify({
      db: testDb(),
      artifactId: 'missing',
      runTaskFn,
    });

    expect(result.status).toBe('skipped:not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:not_ready when generation_status is not ready', async () => {
    await seedAtomic({ artifactId: 'a1', generationStatus: 'pending' });
    const runTaskFn = vi.fn();

    const result = await runNoteVerify({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result.status).toBe('skipped:not_ready');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:no_sections when ready artifact has no sections', async () => {
    await seedAtomic({ artifactId: 'a1', sections: null });
    const runTaskFn = vi.fn();

    const result = await runNoteVerify({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result.status).toBe('skipped:no_sections');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('marks verification_status=verified and writes experimental note_verify event on pass', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));

    const result = await runNoteVerify({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result).toEqual({ status: 'verified', issues_count: 0 });

    const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updated.verification_status).toBe('verified');
    expect(updated.verification_summary).toMatchObject({ verdict: 'pass', confidence: 0.82 });
    expect(updated.verified_by).toMatchObject({ by: 'ai', task_kind: 'NoteVerifyTask' });

    const rows = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'experimental:note_verify',
      subject_kind: 'artifact',
      outcome: 'success',
      actor_ref: 'note_verify',
    });
    expect(rows[0].payload).toMatchObject({ verdict: 'pass' });
  });

  it('marks verification_status=needs_review and persists issues when verifier flags problems', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: NEEDS_REVIEW_OUTPUT }));

    const result = await runNoteVerify({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result).toEqual({ status: 'needs_review', issues_count: 1 });

    const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updated.verification_status).toBe('needs_review');
    expect(updated.verification_summary).toMatchObject({
      verdict: 'needs_review',
      issues: [{ section_id: 's2', category: 'factuality' }],
    });

    const rows = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(rows).toHaveLength(2);
    const verifyEvent = rows.find((row) => row.action === 'experimental:note_verify');
    expect(verifyEvent?.outcome).toBe('partial');
    const proposalEvent = rows.find((row) => row.action === 'experimental:proposal');
    expect((proposalEvent?.payload as { ai_proposal?: { kind?: string } }).ai_proposal?.kind).toBe(
      'note_update',
    );
  });

  it('passes subject profile from knowledge.domain to NoteVerifyTask', async () => {
    await seedAtomic({ artifactId: 'a_math', knowledgeId: 'k_math', domain: 'math' });
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));

    await runNoteVerify({
      db: testDb(),
      artifactId: 'a_math',
      runTaskFn,
    });

    expect(runTaskFn).toHaveBeenCalledWith(
      'NoteVerifyTask',
      expect.objectContaining({
        artifact_id: 'a_math',
        knowledge_node: expect.objectContaining({ domain: 'math' }),
      }),
      expect.objectContaining({
        subjectProfile: expect.objectContaining({ id: 'math' }),
      }),
    );
  });

  it('marks verification_status=failed when verifier output is invalid and rethrows', async () => {
    await seedAtomic({ artifactId: 'a1' });
    const runTaskFn = vi.fn(async () => ({ text: 'not json' }));

    await expect(
      runNoteVerify({
        db: testDb(),
        artifactId: 'a1',
        runTaskFn,
      }),
    ).rejects.toThrow(/parseVerificationOutput/);

    const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updated.verification_status).toBe('failed');
  });
});

describe('buildNoteVerifyHandler — onPassed callback', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('onPassed fires when verdict=pass', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
    const onPassed = vi.fn(async (_id: string) => {});
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn, onPassed });
    await handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never]);
    expect(onPassed).toHaveBeenCalledWith('a1');
  });

  it('onPassed does NOT fire when verdict=needs_review', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: NEEDS_REVIEW_OUTPUT }));
    const onPassed = vi.fn(async (_id: string) => {});
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn, onPassed });
    await handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never]);
    expect(onPassed).not.toHaveBeenCalled();
  });

  it('onPassed does NOT fire when runner throws', async () => {
    await seedAtomic({ artifactId: 'a1' });
    const runTaskFn = vi.fn(async () => ({ text: 'not json' }));
    const onPassed = vi.fn(async (_id: string) => {});
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn, onPassed });
    await expect(handler([{ id: 'job1', data: { artifact_id: 'a1' } } as never])).rejects.toThrow();
    expect(onPassed).not.toHaveBeenCalled();
  });
});
