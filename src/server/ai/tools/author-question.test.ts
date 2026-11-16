import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnswerDraft } from '@/capabilities/practice/api/paper-answer-route';
import { createPaperReviewSession } from '@/capabilities/practice/api/paper-session-create';
import { submitPaperSlot } from '@/capabilities/practice/server/paper-submit';
import {
  authorQuestion,
  authorQuestionTool,
} from '@/capabilities/practice/server/tools/proposal-tools';
import { writeQuizTool } from '@/capabilities/practice/server/tools/write-quiz';
// ADR-0032 D8 — author_question unified question-authoring core + DomainTool.
//
// Proves the front door delegates to the EXISTING code paths without regressing
// the variant guards (HARD INVARIANT #1/#3) or the record_promotion accept
// idempotency (HARD INVARIANT #2):
//   - seed=variant   → practice-owned Failure Learning (guards preserved via delegation)
//   - seed=record    → kind:'record_promotion' / target:'question' → unchanged accept
//   - seed=knowledge|material → typed STUB, writes ZERO proposals (lane B seam)
//
// DB-config test: imports Failure Learning / writeAiProposal / acceptAiProposal /
// @/db, seeds a real Postgres testcontainer.
import {
  answer,
  knowledge,
  learning_record,
  mistake_variant,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import type { ToolContext } from '@/kernel/tools/types';
import { acceptAiProposal } from '@/server/proposals/actions';
import { paperFixtureAssessment } from '../../../../tests/fixtures/assessment-paper';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const mockRunner = vi.hoisted(() => ({ runTask: vi.fn() }));
vi.mock('@/server/ai/runner', () => ({ runTask: mockRunner.runTask }));

const BASE = new Date('2026-06-09T00:00:00.000Z');

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_author_question',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

function deps() {
  return {
    db: testDb(),
    actorRef: 'agent:copilot',
    taskRunId: 'tr_author_question',
  };
}

async function seedFailureAttempt(opts: { withJudge?: boolean } = {}): Promise<void> {
  const db = testDb();
  await db.insert(question).values({
    id: 'q_zhi',
    kind: 'short_answer',
    prompt_md: '解释「之」在句中的作用',
    reference_md: '结构助词。',
    knowledge_ids: ['k_zhi'],
    source: 'manual',
    difficulty: 3,
    created_at: BASE,
    updated_at: BASE,
  });
  await writeEvent(db, {
    id: 'att_failure',
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_zhi',
    outcome: 'failure',
    payload: {
      answer_md: '代词',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_zhi'],
    },
    created_at: new Date(BASE.getTime() + 1_000),
  });
  if (opts.withJudge) {
    await writeEvent(db, {
      id: 'judge_failure',
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'att_failure',
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'concept',
          secondary_categories: ['method'],
          analysis_md: '混淆助词和代词。',
          confidence: 0.86,
        },
        referenced_knowledge_ids: ['k_zhi'],
      },
      caused_by_event_id: 'att_failure',
      created_at: new Date(BASE.getTime() + 2_000),
    });
  }
}

async function seedRecord(id: string): Promise<void> {
  await testDb().insert(learning_record).values({
    id,
    kind: 'open_question',
    title: '之到底是什么',
    content_md: '总是把之误判成代词。',
    source: 'manual',
    capture_mode: 'text',
    activity_kind: 'ask',
    processing_status: 'raw',
    origin_event_id: null,
    subject_id: 'yuwen',
    knowledge_ids: [],
    question_id: null,
    attempt_event_id: null,
    learning_item_id: null,
    artifact_id: null,
    source_document_id: null,
    asset_refs: [],
    payload: {},
    created_at: BASE,
    updated_at: BASE,
  });
}

function mockVariantModelOnce(): void {
  mockRunner.runTask.mockResolvedValueOnce({
    task_run_id: 'tr_variant_model',
    text: JSON.stringify({
      prompt_md: '解释「之」在新句中的用法。',
      reference_md: '结构助词。',
      difficulty: 3,
      reasoning: '同一错因变式。',
    }),
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 20 },
    cost_usd: 0,
  });
}

describe('author_question — variant seed (delegates to Failure Learning)', () => {
  beforeEach(async () => {
    await resetDb();
    mockRunner.runTask.mockReset();
  });

  it('proposes a variant for an active judged failure and writes the variant + proposal rows', async () => {
    const db = testDb();
    await seedFailureAttempt({ withJudge: true });
    mockVariantModelOnce();

    const result = await authorQuestion(
      { seed_mode: 'variant', attempt_event_id: 'att_failure' },
      deps(),
    );
    expect(result.status).toBe('proposed');
    expect(result.seed_mode).toBe('variant');
    expect(result.proposal_ids).toHaveLength(1);
    expect(result.mistake_variant_ids).toHaveLength(1);
    expect(result.variant_question_ids).toEqual([]);

    const variants = await db.select().from(mistake_variant);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      parent_question_id: 'q_zhi',
      proposal_event_id: result.proposal_ids[0],
      status: 'draft',
      cause_category: 'concept',
    });
  });

  it('preserves the no-judge HARD guard via delegation', async () => {
    await seedFailureAttempt({ withJudge: false });
    const result = await authorQuestion(
      { seed_mode: 'variant', attempt_event_id: 'att_failure' },
      deps(),
    );
    expect(result.status).toBe('skipped:no_judge_yet');
    expect(result.proposal_ids).toEqual([]);
    expect(mockRunner.runTask).not.toHaveBeenCalled();
  });

  it('preserves the already-has-variant cooldown via delegation', async () => {
    await seedFailureAttempt({ withJudge: true });
    mockVariantModelOnce();
    const first = await authorQuestion(
      { seed_mode: 'variant', attempt_event_id: 'att_failure' },
      deps(),
    );
    expect(first.status).toBe('proposed');
    const second = await authorQuestion(
      { seed_mode: 'variant', attempt_event_id: 'att_failure' },
      deps(),
    );
    expect(second.status).toBe('skipped:already_has_variant');
  });

  it('remaps not_a_failure_attempt → not_failure_attempt (external vocabulary)', async () => {
    const db = testDb();
    // A non-attempt event id → Failure Learning returns skipped:not_a_failure_attempt.
    await db.insert(question).values({
      id: 'q_x',
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: 'r',
      knowledge_ids: [],
      source: 'manual',
      difficulty: 1,
      created_at: BASE,
      updated_at: BASE,
    });
    await writeEvent(db, {
      id: 'ev_solve',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_x',
      outcome: 'success',
      payload: { answer_md: 'ok', answer_image_refs: [], referenced_knowledge_ids: [] },
      created_at: new Date(BASE.getTime() + 1_000),
    });
    const result = await authorQuestion(
      { seed_mode: 'variant', attempt_event_id: 'ev_solve' },
      deps(),
    );
    expect(result.status).toBe('skipped:not_failure_attempt');
  });

  it('folds permanent variant parse failures into the existing failed contract', async () => {
    await seedFailureAttempt({ withJudge: true });
    mockRunner.runTask.mockResolvedValueOnce({
      task_run_id: 'tr_variant_invalid',
      text: '{"prompt_md":"missing required fields"}',
      cost_usd: 0,
    });

    const result = await authorQuestion(
      { seed_mode: 'variant', attempt_event_id: 'att_failure' },
      deps(),
    );

    expect(result).toMatchObject({
      status: 'failed',
      seed_mode: 'variant',
      proposal_ids: [],
      mistake_variant_ids: [],
      variant_question_ids: [],
    });
    expect(result.reasoning_summary).toBeTruthy();
  });
});

describe('author_question — record seed (record → question via record_promotion)', () => {
  beforeEach(async () => {
    await resetDb();
    mockRunner.runTask.mockReset();
  });

  it('writes a record_promotion proposal pinned to target:question', async () => {
    const db = testDb();
    await seedRecord('rec_open');

    const result = await authorQuestion(
      { seed_mode: 'record', record_id: 'rec_open', reasoning: 'Turn this into a question.' },
      deps(),
    );
    expect(result.status).toBe('proposed');
    expect(result.seed_mode).toBe('record');
    expect(result.proposal_ids).toHaveLength(1);

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows.map((row) => row.kind)).toEqual(['record_promotion']);
    expect(rows[0].payload.proposed_change).toMatchObject({
      record_id: 'rec_open',
      target: 'question',
    });
    expect(rows[0].payload.cooldown_key).toBe('record_promotion:rec_open:question');
  });

  it('threads an optional draft into proposed_change', async () => {
    const db = testDb();
    await seedRecord('rec_open');
    await authorQuestion(
      {
        seed_mode: 'record',
        record_id: 'rec_open',
        reasoning: 'Promote with a draft.',
        draft: { prompt_md: '草稿题干' },
      },
      deps(),
    );
    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows[0].payload.proposed_change).toMatchObject({
      record_id: 'rec_open',
      target: 'question',
      draft: { prompt_md: '草稿题干' },
    });
  });

  it('skips when the record is missing or already pending (dedup preserved)', async () => {
    await seedRecord('rec_open');
    const missing = await authorQuestion(
      { seed_mode: 'record', record_id: 'rec_nope', reasoning: 'x' },
      deps(),
    );
    expect(missing.status).toBe('skipped:not_found');

    const first = await authorQuestion(
      { seed_mode: 'record', record_id: 'rec_open', reasoning: 'first' },
      deps(),
    );
    expect(first.status).toBe('proposed');
    const dup = await authorQuestion(
      { seed_mode: 'record', record_id: 'rec_open', reasoning: 'second' },
      deps(),
    );
    expect(dup.status).toBe('skipped:duplicate_pending');
  });

  it('the written proposal feeds the UNCHANGED accept path idempotently (HARD INVARIANT #2)', async () => {
    const db = testDb();
    await seedRecord('rec_open');
    const result = await authorQuestion(
      { seed_mode: 'record', record_id: 'rec_open', reasoning: 'Promote to a question.' },
      deps(),
    );
    const proposalId = result.proposal_ids[0];

    const accepted = await acceptAiProposal(db, proposalId, { user_note: 'ok' });
    expect(accepted.kind).toBe('record_promotion');
    const materializedId =
      accepted.kind === 'record_promotion' ? accepted.materialized_id : undefined;
    expect(materializedId).toBeTruthy();

    // A materialized question now exists.
    const questions = await db.select().from(question);
    expect(questions.map((q) => q.id)).toContain(materializedId);

    // Accept again → idempotent, no second question row.
    const again = await acceptAiProposal(db, proposalId, { user_note: 'ok again' });
    expect(again.kind).toBe('record_promotion');
    if (again.kind === 'record_promotion') {
      expect(again.idempotent).toBe(true);
      expect(again.materialized_id).toBe(materializedId);
    }
    const questionsAfter = await db.select().from(question);
    expect(questionsAfter).toHaveLength(questions.length);
  });
});

describe('author_question — knowledge|material seed (ADR-0031 lane B)', () => {
  beforeEach(async () => {
    await resetDb();
    mockRunner.runTask.mockReset();
  });

  async function seedKnowledgeNode(id = 'k_zhi'): Promise<void> {
    await testDb().insert(knowledge).values({
      id,
      name: '之的用法',
      domain: 'yuwen',
      created_at: BASE,
      updated_at: BASE,
    });
  }

  function mockAuthorModelOnce(
    options: {
      missingSolverReceipt?: boolean;
      solverFailure?: boolean;
      comparison?: 'weak' | 'wrong';
    } = {},
  ): void {
    mockRunner.runTask.mockResolvedValueOnce({
      task_run_id: 'tr_author_model',
      text: JSON.stringify({
        kind: 'short_answer',
        difficulty: 3,
        knowledge_ids: ['k_zhi'],
        structured: {
          id: 'llm_x',
          role: 'standalone',
          prompt_text: '解释「之」在「学而时习之」中的用法。',
          answers: ['代词。'],
          analysis: '承前指代。',
        },
        // YUK-308 — the judge-executability contract now gates this path:
        // a prose kind needs a semantic route + non-empty required_points
        // (what the prompt instructs the model to emit) or persist is refused.
        judge_kind_override: 'semantic',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: '答出指代作用' }],
          required_points: ['代词', '指代'],
        },
      }),
      cost_usd: 0,
    });
    if (options.solverFailure) {
      mockRunner.runTask.mockRejectedValueOnce(new Error('synthetic solver unavailable'));
      return;
    }
    mockRunner.runTask.mockResolvedValueOnce({
      ...(options.missingSolverReceipt ? {} : { task_run_id: 'tr_independent_solution' }),
      text: JSON.stringify({
        reference_solution: {
          expected_signals: ['之作动词宾语，指代所学内容'],
          final_answer: '代词。',
          answer_equivalents: ['指代学习的内容'],
        },
        worked_solution_md: '「之」是「习」的宾语，承接前面的「学」，所以是代词。',
        confidence: 0.95,
      }),
      cost_usd: 0,
    });
    mockRunner.runTask.mockResolvedValueOnce({
      task_run_id: 'tr_independent_comparison',
      text: JSON.stringify({
        score: options.comparison === 'wrong' ? 0 : 1,
        coarse_outcome: options.comparison === 'wrong' ? 'incorrect' : 'correct',
        confidence: options.comparison === 'weak' ? 0.4 : 0.95,
        feedback_md: '二者均指出代词及宾语指代作用。',
        evidence_json: { matched_points: ['代词', '指代'], missing_points: [] },
      }),
      cost_usd: 0,
    });
  }

  it('knowledge seed: proposes a question_draft, returns the draft question id', async () => {
    const db = testDb();
    await seedKnowledgeNode();
    mockAuthorModelOnce();

    const result = await authorQuestion(
      { seed_mode: 'knowledge', knowledge_ids: ['k_zhi'] },
      deps(),
    );
    expect(result.status).toBe('proposed');
    expect(result.seed_mode).toBe('knowledge');
    expect(result.proposal_ids).toHaveLength(1);
    // ADDITIVE lane-B field: the draft row id (feedable into write_quiz).
    expect(result.question_ids).toHaveLength(1);
    expect(result.mistake_variant_ids).toEqual([]);
    expect(result.variant_question_ids).toEqual([]);
    expect(mockRunner.runTask).toHaveBeenCalledWith(
      'QuestionAuthorTask',
      expect.anything(),
      expect.anything(),
    );

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows.map((row) => row.kind)).toEqual(['question_draft']);
    expect(rows[0].payload.proposed_change).toMatchObject({
      question_id: result.question_ids?.[0],
      seed_mode: 'knowledge',
    });
    const questions = await db.select().from(question);
    expect(questions.map((q) => q.id)).toContain(result.question_ids?.[0]);
    expect(questions.find((q) => q.id === result.question_ids?.[0])?.draft_status).toBe('draft');
  });

  it('material seed: rides the pasted body to the model + stamps provenance', async () => {
    await seedKnowledgeNode();
    mockAuthorModelOnce();
    const result = await authorQuestion(
      {
        seed_mode: 'material',
        knowledge_ids: ['k_zhi'],
        material_body_md: '学而时习之，不亦说乎。',
        material_answer_anchor: {
          canonical_answer: { kind: 'text', value: '通「悦」' },
          locator: { kind: 'text_span', start: 0, end: 33, exact_text: '学而时习之，不亦说乎。' },
        },
        material_url: 'https://example.edu/lunyu',
      },
      deps(),
    );
    expect(result.status).toBe('proposed');
    const input = mockRunner.runTask.mock.calls[0][1] as { material?: { body_md?: string } };
    expect(input.material?.body_md).toBe('学而时习之，不亦说乎。');
  });

  it('opens an authored single-question paper before pool acceptance', async () => {
    await seedKnowledgeNode();
    mockAuthorModelOnce();
    const authored = await authorQuestion(
      { seed_mode: 'knowledge', knowledge_ids: ['k_zhi'] },
      deps(),
    );
    const paper = await writeQuizTool.execute(ctx(), {
      title: '之的用法练习',
      question_ids: authored.question_ids ?? [],
    });

    const opened = await createPaperReviewSession(paper.artifact_id);
    expect(opened.created).toBe(true);
    const rows = await testDb().select().from(question);
    expect(rows.find((q) => q.id === authored.question_ids?.[0])?.draft_status).toBe('draft');
    expect(await listProposalInboxRows(testDb(), { status: 'pending' })).toHaveLength(1);
    const [lifecycle] = await testDb().select().from(question_group_lifecycle);
    expect(lifecycle).toMatchObject({
      availability: 'container_only',
      scoring_admission_state: 'admitted',
    });
    const questionId = authored.question_ids?.[0];
    if (!questionId) throw new Error('author did not return a question');
    const assessment = await paperFixtureAssessment(
      testDb(),
      opened.sessionId,
      questionId,
      '「之」是代词，作「习」的宾语，指代所学内容。',
    );
    const saved = await createAnswerDraft(
      new Request(`http://localhost/api/papers/${paper.artifact_id}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: opened.sessionId,
          question_id: questionId,
          input_kind: 'text',
          content_md: '「之」是代词，作「习」的宾语，指代所学内容。',
          image_refs: [],
          assessment,
        }),
      }),
      { id: paper.artifact_id },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ created: true, save_epoch: 1 });
    const submitted = await submitPaperSlot(
      {
        sessionId: opened.sessionId,
        paperArtifactId: paper.artifact_id,
        questionId,
        assessment,
        answerMd: '「之」是代词，作「习」的宾语，指代所学内容。',
      },
      testDb(),
    );
    expect(submitted.answerId).toBeTruthy();
    // This rule has no admitted automatic executor; recording an answer does not invent a grade.
    expect(submitted.status).toBe('review_required');
    expect(submitted.score).toBeNull();
    const [captured] = await testDb().select().from(answer);
    expect(captured.submitted_at).not.toBeNull();
  });

  it.each([
    {
      label: 'missing independent solver receipt',
      options: { missingSolverReceipt: true },
      reason: 'unverified_rules',
    },
    { label: 'unavailable solver', options: { solverFailure: true }, reason: 'unverified_rules' },
    {
      label: 'weak semantic agreement',
      options: { comparison: 'weak' as const },
      reason: 'unverified_rules',
    },
    {
      label: 'confident disagreement',
      options: { comparison: 'wrong' as const },
      reason: 'verification_failed',
    },
  ])('retains a draft but refuses a runnable paper after $label', async ({ options, reason }) => {
    await seedKnowledgeNode();
    mockAuthorModelOnce(options);
    const authored = await authorQuestion(
      { seed_mode: 'knowledge', knowledge_ids: ['k_zhi'] },
      deps(),
    );
    expect(authored.status).toBe('proposed');
    const [lifecycle] = await testDb().select().from(question_group_lifecycle);
    expect(lifecycle).toMatchObject({
      availability: 'container_only',
      scoring_admission_state: 'withheld',
      scoring_admission_withheld_reason: reason,
    });
    await expect(
      writeQuizTool.execute(ctx(), { question_ids: authored.question_ids ?? [] }),
    ).rejects.toThrow('no usable verified publication');
    expect(await listProposalInboxRows(testDb(), { status: 'pending' })).toHaveLength(1);
  });

  it('scores a verified objective draft without accepting it into the public pool', async () => {
    await testDb().insert(knowledge).values({
      id: 'k_distribution',
      name: '整数乘法与分配律',
      domain: 'math',
      created_at: BASE,
      updated_at: BASE,
    });
    mockRunner.runTask.mockResolvedValueOnce({
      task_run_id: 'tr_math_author',
      cost_usd: 0,
      text: JSON.stringify({
        kind: 'choice',
        difficulty: 2,
        knowledge_ids: ['k_distribution'],
        structured: {
          id: 'model_draft',
          role: 'standalone',
          prompt_text: '运用乘法分配律计算 98×6，以下哪一步正确？',
          answers: ['A'],
          analysis: '将 98 写作 100−2，再分别乘 6，得 600−12=588。',
        },
        choices_md: [
          '(100−2)×6=600−12=588',
          '(100−2)×6=600−2=598',
          '(100+2)×6=600+12=612',
          '98×6=98+6=104',
        ],
        judge_kind_override: 'exact',
      }),
    });
    mockRunner.runTask.mockResolvedValueOnce({
      task_run_id: 'tr_math_solver',
      cost_usd: 0,
      text: JSON.stringify({
        reference_solution: {
          expected_signals: ['98=100−2', '两项都乘6'],
          final_answer: 'A',
          answer_equivalents: [],
        },
        worked_solution_md: '(100−2)×6=100×6−2×6=588，因此选 A。',
        confidence: 0.98,
      }),
    });
    const authored = await authorQuestion(
      { seed_mode: 'knowledge', knowledge_ids: ['k_distribution'], requested_kind: 'choice' },
      deps(),
    );
    const paper = await writeQuizTool.execute(ctx(), { question_ids: authored.question_ids ?? [] });
    const opened = await createPaperReviewSession(paper.artifact_id);
    const questionId = authored.question_ids?.[0];
    if (!questionId) throw new Error('author did not return a question');
    const assessment = await paperFixtureAssessment(testDb(), opened.sessionId, questionId, 'A');
    const result = await submitPaperSlot(
      {
        sessionId: opened.sessionId,
        paperArtifactId: paper.artifact_id,
        questionId,
        assessment,
        answerMd: 'A',
      },
      testDb(),
    );
    expect(result).toMatchObject({ status: 'effective', coarseOutcome: 'correct', score: 1 });
    expect(await listProposalInboxRows(testDb(), { status: 'pending' })).toHaveLength(1);
    const [lifecycle] = await testDb().select().from(question_group_lifecycle);
    expect(lifecycle.availability).toBe('container_only');
    const again = await submitPaperSlot(
      {
        sessionId: opened.sessionId,
        paperArtifactId: paper.artifact_id,
        questionId,
        assessment,
        answerMd: 'A',
      },
      testDb(),
    );
    expect(again.answerId).toBe(result.answerId);
    expect(await testDb().select().from(answer)).toHaveLength(1);
  });

  it('soft-skips knowledge_not_found without an LLM call', async () => {
    const result = await authorQuestion(
      { seed_mode: 'knowledge', knowledge_ids: ['k_nope'] },
      deps(),
    );
    expect(result.status).toBe('skipped:knowledge_not_found');
    expect(result.proposal_ids).toEqual([]);
    expect(mockRunner.runTask).not.toHaveBeenCalled();
  });
});

describe('author_question DomainTool — contract + input validation', () => {
  beforeEach(async () => {
    await resetDb();
    mockRunner.runTask.mockReset();
  });

  it('exposes the expected DomainTool contract fields', () => {
    expect(authorQuestionTool.name).toBe('author_question');
    expect(authorQuestionTool.effect).toBe('propose');
    expect(authorQuestionTool.costClass).toBe('cheap_llm');
    expect(authorQuestionTool.mirrorEvent).toBe('when_causal');
  });

  it('inputSchema is a plain ZodObject (MCP bridge requires it)', () => {
    expect('shape' in authorQuestionTool.inputSchema).toBe(true);
  });

  it('parses each seed_mode discriminant', () => {
    expect(() =>
      authorQuestionTool.inputSchema.parse({ seed_mode: 'variant', attempt_event_id: 'a' }),
    ).not.toThrow();
    expect(() =>
      authorQuestionTool.inputSchema.parse({ seed_mode: 'record', record_id: 'r', reasoning: 'x' }),
    ).not.toThrow();
    expect(() =>
      authorQuestionTool.inputSchema.parse({ seed_mode: 'knowledge', knowledge_ids: ['k'] }),
    ).not.toThrow();
  });

  it('rejects an unknown seed_mode at the schema boundary', () => {
    expect(() => authorQuestionTool.inputSchema.parse({ seed_mode: 'bogus' })).toThrow();
  });

  it("execute returns status:failed for a material seed without material_body_md (URL-only can't ground)", async () => {
    // critic #5: QuestionAuthorTask is single-shot with NO fetch tool — a
    // URL-only material seed would hallucinate the passage, so the cross-field
    // validation rejects it before any LLM call.
    const result = await authorQuestionTool.execute(ctx(), {
      seed_mode: 'material',
      knowledge_ids: ['k_zhi'],
      material_url: 'https://example.edu/only-url',
    });
    expect(result.status).toBe('failed');
    expect(result.reasoning_summary).toContain('material_body_md');
    expect(mockRunner.runTask).not.toHaveBeenCalled();
  });

  it('execute returns status:failed when a per-mode required field is missing', async () => {
    // variant seed without attempt_event_id → cross-field validation throws →
    // wrapper converts to status:'failed'.
    const result = await authorQuestionTool.execute(ctx(), { seed_mode: 'variant' });
    expect(result.status).toBe('failed');
    expect(result.seed_mode).toBe('variant');
    expect(result.reasoning_summary).toContain('attempt_event_id');
    expect(mockRunner.runTask).not.toHaveBeenCalled();
  });

  it('summarize folds seed_mode + status', () => {
    const summary = authorQuestionTool.summarize(
      { seed_mode: 'record' } as never,
      {
        status: 'proposed',
        seed_mode: 'record',
        proposal_ids: ['p1'],
        mistake_variant_ids: [],
        variant_question_ids: [],
      } as never,
    );
    expect(summary).toBe('author_question[record]: proposed');
  });

  it('execute routes a record seed through the core end-to-end', async () => {
    await seedRecord('rec_open');
    const result = await authorQuestionTool.execute(ctx(), {
      seed_mode: 'record',
      record_id: 'rec_open',
      reasoning: 'Promote to a question.',
    });
    expect(result.status).toBe('proposed');
    expect(result.proposal_ids).toHaveLength(1);
  });
});
