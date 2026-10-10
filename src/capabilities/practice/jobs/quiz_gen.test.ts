// Q3 — search-grounded QuizGen handler DB test
// (docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §3 / §4).
//
// Mocks the AI (runAgentTaskFn) + the chained quiz_verify enqueue. Asserts:
//   - questions INSERT with draft_status='draft' (Option B — NOT in the pool),
//     source='quiz_gen', metadata.quiz_gen (generation_status='ready', agent
//     self copy_safety, source_refs, source_pack), source_ref = trigger pointer,
//     created_by = aiAgentRef('QuizGenTask', ...), rubric_json from the agent.
//   - the Tavily remote MCP + in-process domain-tool MCP are mounted, and the
//     allowedTools fold in EXA_MCP_ALLOWED_TOOLS only when a Tavily config is
//     present (env-gated graceful degradation).
//   - quiz_verify is enqueued with { question_ids } on success.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acquirePlacementAttempt } from '@/capabilities/practice/public';
import {
  artifact,
  event,
  knowledge,
  material_fsrs_state,
  placement_starter_attempt_question,
  placement_starter_claim,
  question,
} from '@/db/schema';
import type { PiToolMount } from '@/server/ai/tools/pi-tools';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { canonicalQuestionContentHash } from '../server/quiz/content-fingerprint';
import { runQuizGen } from './quiz_gen';

const FAKE_TAVILY_CONFIG = {
  type: 'http' as const,
  url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=test',
};

// The ctx shape the handler passes to its runAgentTaskFn seam (db + piToolMounts +
// allowedTools). Declared here so `mock.calls[0]` carries it (typed tuple).
type AgentCtx = {
  db: unknown;
  piToolMounts?: PiToolMount[];
  allowedTools?: string[];
};

// ADR-0038 plan-then-generate — the handler chains QuizPlanTask before QuizGenTask,
// so the mock must answer BOTH kinds. Plan-input slice the synthesized plan needs.
type PlanInput = {
  count?: number;
  knowledge_context?: Array<{ id?: string }>;
  requested_generation_method?: string;
  // YUK-1011 — when the run pins 篇 the mirrored plan must mark EVERY item
  // composite:true or the plan gate rejects it before generation.
  composite_parent_only?: boolean;
};

// Synthesizes a QuizPlanTask answer that MIRRORS the generation fixture: same
// question kinds in order, the trigger's real KC, the pinned (or fixture's)
// generation_method — so the deterministic gate accepts the plan and the
// generation output conforms item-for-item without touching each call site.
// Unparseable / empty-question fixtures fall back to a generic valid plan so the
// failure still lands at its ORIGINAL stage (generation parse / exact_count …).
function planTextFor(output: string, input: PlanInput): string {
  type FixtureQuestion = {
    kind?: unknown;
    difficulty?: unknown;
    reference_md?: unknown;
  };
  let questions: FixtureQuestion[] = [];
  let outputMethod: unknown;
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(output.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as { questions?: unknown; generation_method?: unknown };
        if (Array.isArray(obj.questions)) questions = obj.questions as FixtureQuestion[];
        outputMethod = obj.generation_method;
      }
    } catch {
      // malformed fixture — generic fallback plan below
    }
  }
  const fallbackKnowledgeId = input.knowledge_context?.[0]?.id ?? 'k1';
  const isObjective = (kind: unknown): boolean =>
    kind === 'choice' || kind === 'true_false' || kind === 'fill_blank';
  const itemFor = (q: FixtureQuestion) => ({
    // Always plan the trigger's real node: the gate re-reads the knowledge table,
    // so mirroring a fixture's hallucinated id would fail the plan instead of the
    // persist-time salvage path the fixture exists to test.
    knowledge_id: fallbackKnowledgeId,
    kind: typeof q.kind === 'string' ? q.kind : 'short_answer',
    difficulty: typeof q.difficulty === 'number' ? q.difficulty : 3,
    ...(input.composite_parent_only ? { composite: true } : {}),
    ...(isObjective(q.kind) && !input.composite_parent_only
      ? {
          answer_anchor:
            typeof q.reference_md === 'string' && q.reference_md.trim().length > 0
              ? q.reference_md.split('\n')[0].trim()
              : '标准答案',
        }
      : {}),
  });
  const items =
    questions.length > 0
      ? questions.map(itemFor)
      : Array.from({ length: input.count ?? 3 }, () => ({
          knowledge_id: fallbackKnowledgeId,
          kind: 'short_answer',
          difficulty: 3,
        }));
  const method =
    input.requested_generation_method ??
    (typeof outputMethod === 'string' ? outputMethod : undefined) ??
    'closed_book';
  return JSON.stringify({ items, generation_method: method });
}

// Typed agent-mock factory: gives mock.calls[0] the [kind, input, ctx] tuple so
// destructuring the recorded ctx typechecks (the bare vi.fn(async () => …) has
// no declared params → calls[0] is `[]`). Dispatches on kind: QuizPlanTask gets
// the mirrored plan text, everything else gets the fixture output verbatim.
function agentMock(output: string, taskRunId?: string, costUsd?: number) {
  return vi.fn(async (kind: string, input: unknown, _ctx: AgentCtx) => ({
    text: kind === 'QuizPlanTask' ? planTextFor(output, input as PlanInput) : output,
    ...(taskRunId === undefined ? {} : { task_run_id: taskRunId }),
    ...(costUsd === undefined ? {} : { cost_usd: costUsd }),
  }));
}

function twoPartyBarrier() {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await ready;
  };
}

const SEMANTIC_REFERENCE_SOLUTION = {
  expected_signals: ['说明「之」用于主谓之间并取消句子独立性'],
  final_answer: '「之」用在主谓之间，取消句子独立性。',
  answer_equivalents: [],
};

const EXACT_REFERENCE_SOLUTION = {
  expected_signals: ['选择主谓间助词'],
  final_answer: '主谓间助词',
  answer_equivalents: [],
};

const VALID_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '用你自己的话解释「之」作主谓间助词的作用。',
      reference_md: '「之」用在主谓之间，取消句子独立性，使其充当更大句子的成分。',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '说明取消独立性' }],
        required_points: ['用在主谓之间', '取消句子独立性'],
        reference_solution: SEMANTIC_REFERENCE_SOLUTION,
      },
      difficulty: 3,
      knowledge_ids: ['k1'],
      source_refs: [
        {
          url: 'https://example.edu/wenyan/zhi',
          title: '文言虚词「之」',
          snippet: '之用于主谓之间…',
          used_for: 'fact',
          extracted: true,
        },
      ],
    },
    {
      kind: 'choice',
      prompt_md: '下列句中「之」属于哪种用法？',
      reference_md: '主谓间助词',
      choices_md: ['主谓间助词', '代词', '动词'],
      judge_kind_override: 'exact',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '选对选项' }],
        reference_solution: EXACT_REFERENCE_SOLUTION,
      },
      difficulty: 2,
      knowledge_ids: ['k1'],
      source_refs: [
        {
          url: 'https://example.edu/wenyan/zhi',
          title: '文言虚词「之」',
          used_for: 'inspiration',
          extracted: false,
        },
      ],
    },
  ],
  source_pack: {
    query_plan: ['文言 之 主谓间 用法', '之 取消句子独立性 例句'],
    searched_at: '2026-06-02T10:00:00.000Z',
    tool: 'tavily',
  },
  generation_method: 'search_grounded',
  self_copy_safety: { verdict: 'original', max_overlap: 0.12, checked_by: 'agent_self' },
});

// A closed_book run with a real question (closed_book legitimately carries empty
// source_refs). Used by the pinned-method tests so the agent's generation_method
// MATCHES the pin (F1 asserts the pin held).
const CLOSED_BOOK_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '解释「之」作主谓间助词的作用。',
      reference_md: '「之」用在主谓之间，取消句子独立性。',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '说明取消独立性' }],
        required_points: ['用在主谓之间', '取消句子独立性'],
        reference_solution: SEMANTIC_REFERENCE_SOLUTION,
      },
      difficulty: 3,
      knowledge_ids: ['k1'],
      source_refs: [],
    },
  ],
  source_pack: { query_plan: [], searched_at: '2026-06-02T10:00:00.000Z', tool: 'tavily' },
  generation_method: 'closed_book',
  self_copy_safety: { verdict: 'unknown', checked_by: 'agent_self' },
});

async function seedKnowledge(opts: { id: string; domain?: string | null }) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id: opts.id,
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

describe('runQuizGen', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('merges the target KC into an exact duplicate, inserts the remaining question, and audits both', async () => {
    await seedKnowledge({ id: 'k1' });
    const output = JSON.parse(VALID_OUTPUT) as {
      questions: Array<{
        kind: string;
        prompt_md: string;
        reference_md: string;
        choices_md: string[] | null;
        rubric_json: unknown;
      }>;
    };
    const content = output.questions[0];
    const hash = canonicalQuestionContentHash({
      promptMd: content.prompt_md,
      referenceMd: content.reference_md,
      choicesMd: content.choices_md,
      rubricJson: content.rubric_json,
    });
    await testDb()
      .insert(question)
      .values({
        id: 'q-existing-quiz-exact',
        kind: content.kind,
        prompt_md: content.prompt_md,
        reference_md: content.reference_md,
        choices_md: content.choices_md,
        rubric_json: content.rubric_json as never,
        source: 'manual',
        draft_status: 'draft',
        knowledge_ids: ['k-existing'],
        canonical_content_hash: hash,
        created_at: new Date(),
        updated_at: new Date(),
      });
    const enqueueQuizVerify = vi.fn(async () => {});

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn: agentMock(VALID_OUTPUT, 'tr-quiz-merge'),
      enqueueQuizVerify,
      buildExaMcpServerFn: () => FAKE_TAVILY_CONFIG,
    });

    expect(result.question_ids).toHaveLength(1);
    expect(enqueueQuizVerify).toHaveBeenCalledWith(result.question_ids, expect.any(Object));
    const [existing] = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, 'q-existing-quiz-exact'));
    expect(existing).toMatchObject({
      knowledge_ids: ['k-existing', 'k1'],
      draft_status: 'draft',
      version: 1,
    });
    const [mergeEvent] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:question_edit'));
    expect(mergeEvent).toMatchObject({
      actor_ref: 'quiz_gen',
      subject_id: 'q-existing-quiz-exact',
      payload: {
        before: { knowledge_ids: ['k-existing'] },
        after: { knowledge_ids: ['k-existing', 'k1'] },
        reason: 'cross_kc_exact_duplicate',
        task_run_id: 'tr-quiz-merge',
      },
    });
    expect(
      await testDb()
        .select()
        .from(material_fsrs_state)
        .where(eq(material_fsrs_state.subject_id, 'k1')),
    ).toHaveLength(0);
    const [producerEvent] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(producerEvent.payload).toMatchObject({
      exact_duplicate_count: 1,
      exact_duplicate_knowledge_merge_count: 1,
      exact_duplicates: [
        {
          existing_question_id: 'q-existing-quiz-exact',
          new_question_id: expect.any(String),
          canonical_content_hash: hash,
          source_route: 'quiz_gen',
          knowledge_merge_status: 'merged',
          added_knowledge_ids: ['k1'],
          resulting_knowledge_ids: ['k-existing', 'k1'],
          preserved_draft_status: 'draft',
        },
      ],
    });
  });

  it('keeps artifact KC tags aligned when a later item duplicates an earlier row in the same batch', async () => {
    await seedKnowledge({ id: 'k1' });
    await seedKnowledge({ id: 'k2' });
    const parsed = JSON.parse(VALID_OUTPUT) as {
      questions: Array<{
        kind: string;
        prompt_md: string;
        reference_md: string;
        choices_md: string[] | null;
        rubric_json: unknown;
        knowledge_ids: string[];
      }>;
    };
    const first = parsed.questions[0];
    parsed.questions = [
      { ...first, knowledge_ids: ['k1'] },
      { ...first, knowledge_ids: ['k2'] },
    ];

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn: agentMock(JSON.stringify(parsed), 'tr-intra-batch-duplicate'),
      enqueueQuizVerify: vi.fn(async () => {}),
      buildExaMcpServerFn: () => null,
    });

    expect(result.question_ids).toHaveLength(1);
    const [row] = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, result.question_ids?.[0] ?? ''));
    expect(row.knowledge_ids).toEqual(['k1', 'k2']);
    const [quizArtifact] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.tool_quiz_artifact_id ?? ''));
    expect(quizArtifact.knowledge_ids).toEqual(['k1', 'k2']);
    const [producerEvent] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(producerEvent.payload).toMatchObject({
      exact_duplicate_count: 1,
      exact_duplicate_knowledge_merge_count: 1,
    });
  });

  it('reconciles a concurrent canonical-hash race into one draft with both target KCs', async () => {
    await seedKnowledge({ id: 'k1' });
    await seedKnowledge({ id: 'k2' });
    const outputFor = (knowledgeId: string) => {
      const parsed = JSON.parse(CLOSED_BOOK_OUTPUT) as {
        questions: Array<{ knowledge_ids: string[] }>;
      };
      parsed.questions[0].knowledge_ids = [knowledgeId];
      return JSON.stringify(parsed);
    };
    const barrier = twoPartyBarrier();
    const enqueueQuizVerify = vi.fn(async () => {});
    const common = {
      db: testDb(),
      trigger: 'knowledge' as const,
      count: 1,
      enqueueQuizVerify,
      buildExaMcpServerFn: () => null,
      afterExactDuplicateLookupMiss: barrier,
    };

    const results = await Promise.all([
      runQuizGen({ ...common, refId: 'k1', runAgentTaskFn: agentMock(outputFor('k1')) }),
      runQuizGen({ ...common, refId: 'k2', runAgentTaskFn: agentMock(outputFor('k2')) }),
    ]);

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
    expect([...rows[0].knowledge_ids].sort()).toEqual(['k1', 'k2']);
    expect(rows[0]).toMatchObject({ draft_status: 'draft', version: 1 });
    expect(results.map((result) => result.question_ids?.length).sort()).toEqual([0, 1]);
    expect(enqueueQuizVerify).toHaveBeenCalledTimes(1);

    const editEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:question_edit'));
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0].payload).toMatchObject({
      reason: 'cross_kc_exact_duplicate',
      preserved_draft_status: 'draft',
    });
    const producerEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(producerEvents).toHaveLength(2);
    expect(producerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            exact_duplicate_count: 1,
            exact_duplicate_knowledge_merge_count: 1,
            exact_duplicates: [
              expect.objectContaining({
                existing_question_id: rows[0].id,
                knowledge_merge_status: 'merged',
                resulting_knowledge_ids: expect.arrayContaining(['k1', 'k2']),
                preserved_draft_status: 'draft',
              }),
            ],
          }),
        }),
      ]),
    );
  });

  it.each([
    ['draft', true],
    ['active', false],
  ])(
    'drains a raced-duplicate placement question this attempt (%s collider) (YUK-452 followup)',
    async (colliderDraftStatus, expectEnqueued) => {
      // Real wall-clock, NOT a fixed date: acquirePlacementAttempt sets lease_expires_at =
      // now + PLACEMENT_ATTEMPT_LEASE_MS, and assertPlacementAttemptFence compares that lease
      // against transaction_timestamp() — a hardcoded date turns the test into a time bomb the
      // moment real time passes fakeNow + lease.
      const now = new Date();
      await seedKnowledge({ id: 'k-test' });
      await testDb().insert(placement_starter_claim).values({
        id: 'claim-raced',
        fingerprint: 'placement-starter|raced',
        goal_id: 'goal-raced',
        semantic_goal_revision_id: 'rev-raced',
        subject_id: 'wenyan',
        knowledge_id: 'k-test',
        demand_id: 'demand-raced',
        target_id: 'target-raced',
        status: 'queued',
        pg_boss_job_id: 'job-raced',
        max_paid_attempts: 3,
        budget_limit_micro_usd: 1_000_000,
        known_cost_micro_usd: 0,
        next_reconcile_at: now,
        created_at: now,
        updated_at: now,
      });
      const attempt = await acquirePlacementAttempt(testDb(), {
        claimId: 'claim-raced',
        pgBossJobId: 'job-raced',
        deliveryNo: 1,
        startedOn: now,
        now,
      });
      // The content the placement run is about to generate — inject a colliding row at the
      // insert-time race window (afterExactDuplicateLookupMiss) so runQuizGen's own insert loses the
      // canonical-hash race and falls into the racedDuplicate branch.
      const collider = JSON.parse(CLOSED_BOOK_OUTPUT).questions[0];
      const hash = canonicalQuestionContentHash({
        promptMd: collider.prompt_md,
        referenceMd: collider.reference_md,
        choicesMd: collider.choices_md,
        rubricJson: collider.rubric_json,
      });
      const enqueueQuizVerify = vi.fn(
        async (_ids: string[], _options?: unknown, _authorities?: unknown) => {},
      );
      const result = await runQuizGen({
        db: testDb(),
        trigger: 'knowledge',
        refId: 'k-test',
        count: 1,
        placementAttempt: attempt,
        runAgentTaskFn: agentMock(CLOSED_BOOK_OUTPUT, 'tr-raced', 0),
        enqueueQuizVerify,
        buildExaMcpServerFn: () => null,
        afterExactDuplicateLookupMiss: async () => {
          await testDb()
            .insert(question)
            .values({
              id: 'raced-existing',
              kind: 'short_answer',
              prompt_md: collider.prompt_md,
              reference_md: collider.reference_md,
              knowledge_ids: ['k-test'],
              difficulty: 3,
              source: 'quiz_gen',
              source_ref: 'k-test',
              draft_status: colliderDraftStatus as 'draft' | 'active',
              metadata: {},
              canonical_content_hash: hash,
              created_at: now,
              updated_at: now,
            });
        },
      });

      // The run's own insert lost the race → it authorized the existing row, not a new one.
      expect(result.question_ids).toHaveLength(0);
      const [aq] = await testDb()
        .select()
        .from(placement_starter_attempt_question)
        .where(eq(placement_starter_attempt_question.question_id, 'raced-existing'));
      expect(aq?.attempt_id).toBe(attempt.attemptId);
      // A DRAFT raced duplicate must be drained THIS attempt (quiz_verify enqueued). An ACTIVE one is
      // terminal_skipped by the outbox (it settles via pool-visibility) so it is NOT enqueued.
      const enqueuedIds = enqueueQuizVerify.mock.calls.flatMap((call) => call[0]);
      expect(enqueuedIds.includes('raced-existing')).toBe(expectEnqueued);
    },
  );

  it('does not create a ready artifact when the whole batch is exact duplicates', async () => {
    await seedKnowledge({ id: 'k1' });
    const output = JSON.parse(VALID_OUTPUT) as {
      questions: Array<{
        kind: string;
        prompt_md: string;
        reference_md: string;
        choices_md: string[] | null;
        rubric_json: unknown;
      }>;
    };
    await testDb()
      .insert(question)
      .values(
        output.questions.map((content, index) => ({
          id: `q-existing-all-dup-${index}`,
          kind: content.kind,
          prompt_md: content.prompt_md,
          reference_md: content.reference_md,
          choices_md: content.choices_md,
          rubric_json: content.rubric_json as never,
          source: 'manual',
          draft_status: 'draft',
          canonical_content_hash: canonicalQuestionContentHash({
            promptMd: content.prompt_md,
            referenceMd: content.reference_md,
            choicesMd: content.choices_md,
            rubricJson: content.rubric_json,
          }),
          created_at: new Date(),
          updated_at: new Date(),
        })),
      );
    const enqueueQuizVerify = vi.fn(async () => {});

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn: agentMock(VALID_OUTPUT),
      enqueueQuizVerify,
      buildExaMcpServerFn: () => FAKE_TAVILY_CONFIG,
    });

    expect(result.question_ids).toHaveLength(0);
    expect(enqueueQuizVerify).not.toHaveBeenCalled();
    // A zero-question quiz must never surface as practicable: no artifact row.
    const artifacts = await testDb()
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.tool_kind, 'quiz_gen'));
    expect(artifacts).toHaveLength(0);
    const [producerEvent] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(producerEvent.payload).toMatchObject({
      count: 0,
      tool_quiz_artifact_id: null,
      exact_duplicate_count: 2,
      exact_duplicate_knowledge_merge_count: 2,
    });
  });
});
