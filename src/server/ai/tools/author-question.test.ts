// ADR-0032 D8 — author_question unified question-authoring core + DomainTool.
//
// Proves the front door delegates to the EXISTING code paths without regressing
// the variant guards (HARD INVARIANT #1/#3) or the record_promotion accept
// idempotency (HARD INVARIANT #2):
//   - seed=variant   → runVariantGen UNCHANGED (guards preserved via delegation)
//   - seed=record    → kind:'record_promotion' / target:'question' → unchanged accept
//   - seed=knowledge|material → typed STUB, writes ZERO proposals (lane B seam)
//
// DB-config test: imports runVariantGen / writeAiProposal / acceptAiProposal /
// @/db, seeds a real Postgres testcontainer.
import { event, learning_record, mistake_variant, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { acceptAiProposal } from '@/server/proposals/actions';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { authorQuestion, authorQuestionTool } from './proposal-tools';
import type { ToolContext } from './types';

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
    subject_id: 'wenyan',
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

describe('author_question — variant seed (delegates to runVariantGen)', () => {
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
    // A non-attempt event id → runVariantGen returns skipped:not_a_failure_attempt.
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

describe('author_question — knowledge|material seed (lane B stub)', () => {
  beforeEach(async () => {
    await resetDb();
    mockRunner.runTask.mockReset();
  });

  it.each(['knowledge', 'material'] as const)(
    'returns not_implemented and writes ZERO proposals for seed_mode=%s',
    async (seedMode) => {
      const db = testDb();
      const before = await db.select().from(event);
      const result = await authorQuestion(
        { seed_mode: seedMode, knowledge_ids: ['k_zhi'] },
        deps(),
      );
      expect(result.status).toBe('skipped:not_implemented');
      expect(result.seed_mode).toBe(seedMode);
      expect(result.proposal_ids).toEqual([]);
      const after = await db.select().from(event);
      expect(after).toHaveLength(before.length);
      const rows = await listProposalInboxRows(db, { status: 'pending' });
      expect(rows).toHaveLength(0);
      expect(mockRunner.runTask).not.toHaveBeenCalled();
    },
  );
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
    // mcp-bridge.ts does `instanceof z.ZodObject` and reads `.shape`. A
    // .superRefine/.refine would produce a ZodEffects and break the bridge.
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
