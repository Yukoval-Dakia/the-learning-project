import { noteSectionsToBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import { artifact, event, knowledge, material_fsrs_state, question } from '@/db/schema';
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
    body_md: '主谓之间的「之」常不译。',
    source_tier: 'llm_only',
    user_verified: false,
    embedded_check: null,
    version: 1,
  },
  {
    id: 's5',
    kind: 'check',
    body_md: '自检：判断句中「之」的作用。',
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
      block_id: 'b2',
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
  artifactType?: 'note_atomic' | 'note_long';
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
    type: opts.artifactType ?? 'note_atomic',
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

    expect(result).toMatchObject({
      status: 'verified',
      artifact_type: 'note_atomic',
      issues_count: 0,
    });

    const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updated.verification_status).toBe('verified');
    expect(updated.verification_summary).toMatchObject({ verdict: 'pass', confidence: 0.82 });
    expect(updated.verified_by).toMatchObject({ by: 'ai', task_kind: 'NoteVerifyTask' });

    // W3-C1γ — persistNoteVerificationResult now writes TWO events: the observability
    // experimental:note_verify (unchanged) + the fold-source experimental:artifact_lifecycle
    // (set_verification_status) carrying status + summary + verified_by.
    const rows = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(rows).toHaveLength(2);
    const verifyRow = rows.find((r) => r.action === 'experimental:note_verify');
    expect(verifyRow).toMatchObject({
      action: 'experimental:note_verify',
      subject_kind: 'artifact',
      outcome: 'success',
      actor_ref: 'note_verify',
    });
    // SUPERSET payload: existing `verdict` kept byte-identical + unified contract keys.
    expect(verifyRow?.payload).toMatchObject({ verdict: 'pass' });
    // YUK-350 increment 2 — unified verify contract shape: note pass → overall 'pass',
    // NO failure_class.
    const payload = verifyRow?.payload as {
      overall?: string;
      failure_class?: string;
      axes?: unknown;
    };
    expect(payload.overall).toBe('pass');
    expect(payload.failure_class).toBeUndefined();
    expect(Array.isArray(payload.axes)).toBe(true);
    // W3-C1γ fold-source lifecycle event: op=set_verification_status + carried summary + verified_by.
    const lifecycleRow = rows.find((r) => r.action === 'experimental:artifact_lifecycle');
    expect(lifecycleRow?.payload).toMatchObject({
      op: 'set_verification_status',
      verification_status: 'verified',
    });
    expect((lifecycleRow?.payload as { verified_by?: { by?: string } }).verified_by?.by).toBe('ai');

    // PROMOTE semantics byte-identical: a note promote = an owner-readable ACTIVE
    // artifact (verification_status='verified'). NO FSRS enroll and NO practice-pool
    // entry — notes are not practice items. Assert nothing leaked into the pool/FSRS.
    const fsrsRows = await testDb()
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k1'));
    expect(fsrsRows).toHaveLength(0);
    const questionRows = await testDb().select().from(question);
    expect(questionRows).toHaveLength(0);
  });

  it('marks verification_status=needs_review and persists issues when verifier flags problems', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: NEEDS_REVIEW_OUTPUT }));

    const result = await runNoteVerify({
      db: testDb(),
      artifactId: 'a1',
      runTaskFn,
    });

    expect(result).toMatchObject({
      status: 'needs_review',
      artifact_type: 'note_atomic',
      issues_count: 1,
    });

    const [updated] = await testDb().select().from(artifact).where(eq(artifact.id, 'a1'));
    expect(updated.verification_status).toBe('needs_review');
    expect(updated.verification_summary).toMatchObject({
      verdict: 'needs_review',
      issues: [{ block_id: 'b2', category: 'factuality' }],
    });

    // RED-1 (YUK-358 决定7) — the DEAD patch-less note_update proposal is GONE.
    // note_verify's needs_review branch no longer writes a proposal at all; the
    // advisory (verification_summary + the experimental:note_verify event) is the
    // ONLY user-facing artifact of a needs_review verdict — NOT a proposal. W3-C1γ
    // ADDS the fold-source experimental:artifact_lifecycle event (set_verification_status),
    // so there are TWO events: the verify event + the lifecycle event (no proposal).
    const rows = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.action === 'experimental:artifact_lifecycle')).toBe(true);
    const verifyEvent = rows.find((row) => row.action === 'experimental:note_verify');
    expect(verifyEvent).toBeDefined();
    expect(verifyEvent?.outcome).toBe('partial');
    // YUK-350 increment 2 — unified verify contract shape: note needs_review →
    // overall 'needs_review' + failure_class 'validation_failure'; NEVER 'fail' (the
    // note verdict has no fail). Existing `verdict` key kept byte-identical.
    const vp = verifyEvent?.payload as {
      verdict?: string;
      overall?: string;
      failure_class?: string;
      axes?: Array<{ axis_name?: string; verdict?: string }>;
    };
    expect(vp.verdict).toBe('needs_review');
    expect(vp.overall).toBe('needs_review');
    expect(vp.overall).not.toBe('fail');
    expect(vp.failure_class).toBe('validation_failure');
    expect(vp.axes?.[0]?.axis_name).toBe('factuality');

    // Advisory NOT regressed: verification_summary still carries the issues so they
    // stay visible to the owner even with the dead proposal removed (red line 3).
    expect(updated.verification_summary).toMatchObject({
      verdict: 'needs_review',
      issues: [{ block_id: 'b2', message: '例句解释缺少文本证据。' }],
    });

    // The patch-less note_update proposal MUST NOT exist anymore.
    const proposalEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    expect(proposalEvents).toHaveLength(0);
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
        // YUK-228 (S3 Slice B): handler must pass resolveNoteSkill(subject) as skills.
        skills: ['note-math'],
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

  it('catch-bottom projects overall=error + failure_class=system_error (transient, outcome=error)', async () => {
    await seedAtomic({ artifactId: 'a1', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: 'not json' }));

    await expect(runNoteVerify({ db: testDb(), artifactId: 'a1', runTaskFn })).rejects.toThrow(
      /parseVerificationOutput/,
    );

    // The catch-bottom writes a TRANSIENT system-error verify event. overall='error'
    // (the result-layer 'error' value can ONLY come from here — the note LLM-parse
    // schema can never self-report it, red line 1) + failure_class='system_error'.
    // W3-C1γ — the catch-bottom now ALSO emits the fold-source lifecycle event
    // (set_verification_status='failed') in the SAME tx, so there are TWO events.
    const rows = await testDb().select().from(event).where(eq(event.subject_id, 'a1'));
    expect(rows).toHaveLength(2);
    const failedLifecycle = rows.find((r) => r.action === 'experimental:artifact_lifecycle');
    expect(failedLifecycle?.payload).toMatchObject({
      op: 'set_verification_status',
      verification_status: 'failed',
    });
    const errEvent = rows.find((r) => r.action === 'experimental:note_verify');
    expect(errEvent).toBeDefined();
    if (!errEvent) throw new Error('expected note_verify error event');
    expect(errEvent.action).toBe('experimental:note_verify');
    expect(errEvent.subject_kind).toBe('artifact');
    // outcome='error' (NOT 'failure') marks it transient/retriable, distinct from a
    // terminal model verdict.
    expect(errEvent.outcome).toBe('error');
    const ep = errEvent.payload as {
      overall?: string;
      failure_class?: string;
      confidence?: number;
      axes?: unknown[];
    };
    expect(ep.overall).toBe('error');
    expect(ep.failure_class).toBe('system_error');
    expect(ep.confidence).toBe(0);
    expect(ep.axes).toHaveLength(0);

    // A system error NEVER promotes: still no FSRS / no practice-pool entry.
    const fsrsRows = await testDb()
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k1'));
    expect(fsrsRows).toHaveLength(0);
    const questionRows = await testDb().select().from(question);
    expect(questionRows).toHaveLength(0);
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

  it('onPassed does NOT fire for verified long notes', async () => {
    await seedAtomic({ artifactId: 'a_long', artifactType: 'note_long', knowledgeId: 'k1' });
    const runTaskFn = vi.fn(async () => ({ text: PASS_OUTPUT }));
    const onPassed = vi.fn(async (_id: string) => {});
    const handler = buildNoteVerifyHandler(testDb(), { runTaskFn, onPassed });

    await handler([{ id: 'job1', data: { artifact_id: 'a_long' } } as never]);

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
