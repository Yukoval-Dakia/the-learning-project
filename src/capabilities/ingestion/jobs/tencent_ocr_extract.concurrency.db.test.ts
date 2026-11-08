import { createHash } from 'node:crypto';
import {
  type AssistantMessage,
  type Context,
  type Model,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enrichEvidenceCells } from '@/capabilities/agency/server/conjecture/evidence-enrichment';
import { reserveIngestionOperation } from '@/capabilities/ingestion/server/operation-store';
import { TencentSubmitInProgressError } from '@/capabilities/ingestion/server/provider-attempts';
import type { DescribeResponse } from '@/capabilities/ingestion/server/tencent_mark';
import { createPiModelExecutor } from '@/capabilities/practice/grading/server/pi-model-executor';
import { installPracticeHost } from '@/capabilities/practice/public';
import { loadGradedContract } from '@/capabilities/practice/question-bank/jobs/question_admission_run';
import {
  definitionFromContract,
  runQuestionAdmission,
} from '@/capabilities/practice/question-bank/server/admission';
import { getQuestionContextTool } from '@/capabilities/practice/scheduling/tools/question-context';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { LEARNER_HANDWRITING_RULE } from '@/core/schema/structured_question';
import { db } from '@/db/client';
import {
  learning_session,
  provider_attempt,
  question,
  question_block,
  question_group_lifecycle,
  source_asset,
} from '@/db/schema';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { type PiAdapterDeps, PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import tencentDone from '../../../../tests/fixtures/tencent_mark_agent_cloze_sample.json';
import tencentFigure from '../../../../tests/fixtures/tencent_mark_agent_figure_sample.json';
import { resetDb } from '../../../../tests/helpers/db';
import { IngestionBlocksResponseSchema } from '../api/contracts';
import { enrollBlockIntoItemBank } from '../server/item-bank-enrollment';
import { readIngestionSessionBlocks } from '../server/session-blocks-read';
import { StructureTaskError, runStructureTask } from '../server/structure';
import { createImageR2, seedIngestionSession } from './ingestion-test-support';
import { buildTencentOcrHandler } from './tencent_ocr_extract';

function structureResult() {
  return {
    questions: [
      {
        id: 'concurrency-question',
        role: 'standalone' as const,
        prompt_text: 'single aggregate result',
        source: 'vlm_structure' as const,
      },
    ],
    layout_quality: 'structured' as const,
    extraction_confidence: 0.9,
    warnings: [],
  };
}

async function reserveOperation(sessionId: string, operationId: string): Promise<void> {
  await reserveIngestionOperation(db, {
    sessionId,
    operationId,
    operationKind: 'extract',
    inputHash: `hash-${operationId}`,
  });
}

beforeAll(installPracticeHost);
beforeEach(async () => {
  vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'observe');
  vi.stubEnv(
    'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
    JSON.stringify({
      'tencent.question-mark-agent': {
        maxConcurrentAttempts: 100,
        maxAttemptStartsPerMinute: 1000,
      },
    }),
  );
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

describe('Tencent OCR concurrent delivery fencing', () => {
  it('sends one Submit when different final retry generations overlap', async () => {
    // Given: generation 0 is paused inside the provider Submit wire.
    const { sessionId, operationId } = await seedIngestionSession(1);
    await reserveOperation(sessionId, operationId);
    let releaseWinner: () => void = () => undefined;
    const winnerRelease = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let winnerEntered: () => void = () => undefined;
    const winnerWireEntered = new Promise<void>((resolve) => {
      winnerEntered = resolve;
    });
    let competitionObserved: () => void = () => undefined;
    const competitionReachedFenceOrWire = new Promise<void>((resolve) => {
      competitionObserved = resolve;
    });
    let submitCount = 0;
    const submitFn = vi.fn(async () => {
      submitCount += 1;
      if (submitCount === 1) {
        winnerEntered();
        await winnerRelease;
        return 'winner-job-id';
      }
      competitionObserved();
      return 'duplicate-job-id';
    });
    const handler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn,
      describeFn: vi.fn(
        async (_jobId: string): Promise<DescribeResponse> => ({
          ...tencentDone,
          JobStatus: 'DONE',
        }),
      ),
      runStructureFn: vi.fn(async () => structureResult()),
    });
    const delivery = {
      id: 'overlapping-generation-job',
      data: { sessionId, operationId },
      retryCount: 0,
      retryLimit: 2,
      startedOn: new Date(),
    };

    // When: a competing delivery reaches history resolution before generation 0 persists its JobId.
    const winner = handler([delivery] as never);
    await winnerWireEntered;
    const competitor = handler([{ ...delivery, retryCount: 2 }] as never);
    competitor.finally(competitionObserved).catch(() => undefined);
    await competitionReachedFenceOrWire;
    releaseWinner();
    const outcomes = await Promise.allSettled([winner, competitor]);

    // Then: the attempt fence permits one wire and the competition never terminalizes extraction.
    expect(submitFn).toHaveBeenCalledOnce();
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(TencentSubmitInProgressError);
    expect(rejected?.reason.reason).toBe('active_duplicate');
    const session = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0]?.status).toBe('extracted');
    const submitAttempts = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.operation_kind, 'ocr_page_submit'));
    expect(submitAttempts).toHaveLength(1);
  });
});

const objects = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/kernel/object-storage', () => ({
  getR2: () => ({ get: async (key: string) => objects.get(key) ?? null }),
}));

/** Page reads return the blank page; crop uploads are kept so admission can load them. */
async function storingR2() {
  const page = await createImageR2();
  return {
    async get(key: string) {
      return objects.get(key) ?? page.get();
    },
    async put(key: string, body: Uint8Array) {
      objects.set(key, body);
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
}

const solverModel: Model<'openai-completions'> = {
  id: 'deepseek-v4.1-flash',
  name: 'offline',
  provider: 'opencode-go',
  api: 'openai-completions',
  baseUrl: 'https://offline.invalid',
  reasoning: false,
  input: ['text', 'image'],
  contextWindow: 10000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Real runner and pi adapter; only the provider stream is scripted, and it records every context. */
function captureProviderContexts(): Context[] {
  const contexts: Context[] = [];
  const streamSimple: NonNullable<PiAdapterDeps['models']>['streamSimple'] = (_model, context) => {
    contexts.push(context);
    const message: AssistantMessage = {
      role: 'assistant',
      api: solverModel.api,
      provider: solverModel.provider,
      model: solverModel.id,
      content: [{ type: 'text', text: '{}' }],
      stopReason: 'stop',
      timestamp: 1,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  };
  __setPiAdapterForTests(
    new PiAgentAdapter({ models: { getModel: () => solverModel, streamSimple } }),
  );
  return contexts;
}

async function runHandler(handler: ReturnType<typeof buildTencentOcrHandler>, sessionId: string) {
  await handler([
    {
      id: `crop-${sessionId}`,
      data: { sessionId },
      retryCount: 0,
      retryLimit: 0,
      startedOn: new Date(),
    },
  ] as never);
  const [block] = await db
    .select()
    .from(question_block)
    .where(eq(question_block.ingestion_session_id, sessionId));
  return block;
}

/** Blind solve, the companion question context and conjecture evidence all see this figure marker. */
async function expectModelReadersSee(questionId: string, marker: boolean | 'unknown') {
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, questionId));
  const { contract } = await loadGradedContract(
    db,
    questionId,
    lifecycle?.current_revision_id ?? null,
  );
  const contexts = captureProviderContexts();
  await runQuestionAdmission(definitionFromContract(contract), {
    db,
    runTask: makeRunTaskTextFn(db),
  });
  const [solveRequest] = contexts;
  if (!solveRequest) throw new Error('blind solve never reached the provider');
  const user = solveRequest.messages.find((message) => message.role === 'user');
  const content = Array.isArray(user?.content) ? user.content : [];
  expect(content.filter((part) => part.type === 'image')).toHaveLength(1);
  expect(JSON.stringify(content)).toContain(`contains_learner_handwriting: ${marker}`);
  const system = solveRequest.messages.find((message) => (message.role as string) === 'system');
  expect(JSON.stringify(system?.content)).toContain(LEARNER_HANDWRITING_RULE);

  // Grading reads question figures as conditions, so the judge must see the same marker.
  const [unit] = contract.scoring_basis.units;
  if (!unit || !lifecycle?.current_revision_id) throw new Error('published unit missing');
  const gradingContexts = captureProviderContexts();
  await createPiModelExecutor({ db, deadlineAt: Date.now() + 60_000, maxCostUsdMicros: 1_000_000 })(
    {
      submission_id: `sub-${questionId}`,
      evaluation_group_id: `eg-${questionId}`,
      revision_id: lifecycle.current_revision_id,
      attempt: 1,
      scoring_unit_id: unit.scoring_unit_id,
      executor: {
        kind: 'model_executor',
        task_kind: 'AssessmentRuleJudgeTask',
        admitted_slice_id: 'slice-figures',
        max_cost_usd_micros: 1_000_000,
      },
      unit: {
        ...unit,
        criterion: {
          kind: 'rule_reference',
          rule_id: 'r1',
          statement_md: '角A为30°',
          source: 'manual',
        },
      },
      question_parts: contract.structure.parts,
      response_slots: contract.response_spec.slots,
      slot_responses: [],
      group_evidence: [],
      materials: contract.structure.materials.filter((material) => material.kind === 'figure'),
      spent_cost_usd_micros: 0,
    },
  );
  const [gradeRequest] = gradingContexts;
  if (!gradeRequest) throw new Error('grading never reached the provider');
  const gradeUser = gradeRequest.messages.find((message) => message.role === 'user');
  const gradeContent = Array.isArray(gradeUser?.content) ? gradeUser.content : [];
  expect(gradeContent.filter((part) => part.type === 'image')).toHaveLength(1);
  const gradeText = gradeContent.find((part) => part.type === 'text');
  const gradeInput = JSON.parse(gradeText?.type === 'text' ? gradeText.text : '{}') as {
    image_manifest: { contains_learner_handwriting?: unknown }[];
  };
  expect(gradeInput.image_manifest.map((entry) => entry.contains_learner_handwriting)).toEqual([
    marker,
  ]);
  const gradeSystem = gradeRequest.messages.find(
    (message) => (message.role as string) === 'system',
  );
  expect(JSON.stringify(gradeSystem?.content)).toContain(LEARNER_HANDWRITING_RULE);

  const companion = await getQuestionContextTool.execute(
    { db, taskRunId: 'tr_figures', callerActor: { kind: 'agent', ref: 'agent:copilot' } },
    { questionId, include: ['assets', 'structure'] },
  );
  expect(
    companion.source_assets
      ?.filter((asset) => asset.role === 'diagram')
      .map((asset) => asset.contains_learner_handwriting),
  ).toEqual([marker]);
  expect(companion.structure?.figures.map((figure) => figure.contains_learner_handwriting)).toEqual(
    [marker],
  );
  const attemptId = `attempt-${questionId}`;
  const [cell] = await enrichEvidenceCells(db, {
    cells: [
      {
        key: `concept:${attemptId}`,
        cause_category: 'concept',
        knowledge_id: 'k-figures',
        recurrence_count: 1,
        evidence_event_ids: [attemptId],
        theta_hat: null,
        theta_precision: null,
        baseline_p: null,
        probe_here: false,
        has_owner_cause: false,
        has_contested_verdict: false,
      },
    ],
    failures: [
      {
        attempt_event_id: attemptId,
        question_id: questionId,
        answer_md: '60°',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
        created_at: new Date(),
      },
    ],
  });
  expect(
    cell?.samples[0]?.question_figures.map((figure) => figure.contains_learner_handwriting),
  ).toEqual([marker]);
}

/** A sourced question with a printed figure, stored with or without a marker. */
async function seedPrintedFigureQuestion(stored?: boolean | 'unknown'): Promise<string> {
  const bytes = await (await createImageR2()).get();
  const assetId = `printed-${createId()}`;
  const storageKey = `printed/${assetId}.png`;
  objects.set(storageKey, bytes);
  const now = new Date();
  await db.insert(source_asset).values({
    id: assetId,
    kind: 'image',
    storage_key: storageKey,
    mime_type: 'image/png',
    byte_size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 80,
    height: 120,
    provenance: { origin: 'jyeoo_staged', fetch_run_id: 'fixture' },
    created_at: now,
  });
  const questionId = createId();
  await db.insert(question).values(
    withAnswerClass({
      id: questionId,
      kind: 'choice',
      prompt_md: '如图，三角形中角A等于多少度？',
      choices_md: ['30°', '60°'],
      structured: {
        id: questionId,
        kind: 'choice',
        role: 'standalone',
        prompt_text: '如图，三角形中角A等于多少度？',
        options: [
          { label: 'A', text: '30°' },
          { label: 'B', text: '60°' },
        ],
      },
      figures: [
        {
          asset_id: assetId,
          role: 'diagram',
          source_page_index: 0,
          source_bbox: { x: 0, y: 0, width: 1, height: 1 },
          attached_to_index: questionId,
          attach_confidence: 'high',
          ...(stored === undefined ? {} : { contains_learner_handwriting: stored }),
        },
      ],
      image_refs: [],
      knowledge_ids: [],
      difficulty: 3,
      source: 'jyeoo',
      variant_depth: 0,
      draft_status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
      version: 0,
    }),
  );
  await publishQuestionGroupFromRow(db, { rootId: questionId, actorRef: 'fixture', now });
  return questionId;
}

// @invariant security: every attributable crop of a question with learner work reaches blind solve, grading, the companion question context and conjecture evidence carrying its learner-handwriting marker; an unmarked printed figure reads as free of handwriting, a stored marker always wins, and the solve and grading prompts state that handwriting is not a condition or answer
// @fails-if a whole-question handwriting veto drops the crop, a handwritten or undecided crop is withheld, the marker is lost before the solve or grading request or in the companion/conjecture projections, an unmarked printed figure is told to models as possibly handwritten, a stored marker is overridden by the origin default, or the solve or grading prompt omits the handwriting rule
it('gives every question figure to blind solve, grading, the companion and conjecture evidence with its learner-handwriting marker', async () => {
  vi.stubEnv('OPENCODE_API_KEY', 'synthetic-fixture-key');
  vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
  vi.stubEnv('AI_PROVIDER_MODEL', '');
  setTestConfig({
    'task.QuestionAdmissionSolveTask.provider': 'opencode-go',
    'task.QuestionAdmissionSolveTask.model': solverModel.id,
    'task.QuestionAdmissionSolveTask.override_global_pin': true,
    'task.AssessmentRuleJudgeTask.provider': 'opencode-go',
    'task.AssessmentRuleJudgeTask.model': solverModel.id,
    'task.AssessmentRuleJudgeTask.override_global_pin': true,
  });
  const cases: Array<{
    printed?: true;
    stored?: boolean | 'unknown';
    judgment?: boolean | null;
    optionLabel?: string | null;
    marker: boolean | 'unknown' | null;
  }> = [
    { judgment: false, optionLabel: null, marker: false },
    { judgment: true, optionLabel: null, marker: true },
    { judgment: null, optionLabel: null, marker: 'unknown' },
    // An omitted judgment must not fail the whole StructureOutput parse.
    { judgment: undefined, optionLabel: 'A', marker: 'unknown' },
    // FigureRef.option_label.min(1): an empty option label claim stays unbound.
    { judgment: false, optionLabel: '', marker: null },
    // Not cut from a learner's page: no marker stored, and none can be learner work.
    { printed: true, marker: false },
    // A stored marker is never replaced by the origin default.
    { printed: true, stored: true, marker: true },
  ];
  try {
    for (const expected of cases) {
      if (expected.printed) {
        if (expected.marker === null) throw new Error('printed row needs a marker');
        await expectModelReadersSee(
          await seedPrintedFigureQuestion(expected.stored),
          expected.marker,
        );
        continue;
      }
      const { sessionId } = await seedIngestionSession(1);
      const optionClaim = expected.optionLabel != null;
      const handler = buildTencentOcrHandler({
        db,
        r2: await storingR2(),
        engine: 'glm',
        glmOcrFn: async () => ({
          id: 'crop-layout',
          request_id: 'crop-layout',
          md_results: '1. 如图，三角形中角A等于多少度？',
          data_info: { num_pages: 1, pages: [{ width: 80, height: 120 }] },
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          layout_details: [
            [
              {
                index: 0,
                label: 'text',
                native_label: 'paragraph',
                bbox_2d: [0, 0, 80, 30],
                width: 80,
                height: 120,
                content: '1. 如图，三角形中角A等于多少度？',
              },
              {
                index: 1,
                label: 'image',
                native_label: 'image',
                bbox_2d: [10, 40, 50, 80],
                width: 80,
                height: 120,
              },
            ],
          ],
        }),
        runStructureFn: (params) =>
          runStructureTask({
            ...params,
            runTaskFn: async () => ({
              text: JSON.stringify({
                layout_quality: 'structured',
                extraction_confidence: 0.9,
                content_lost: false,
                figure_handwriting: [
                  { figure_index: 0, student_answer_present: expected.judgment },
                ],
                questions: [
                  {
                    kind: 'choice',
                    role: 'standalone',
                    question_no: '1',
                    prompt_text: '如图，三角形中角A等于多少度？',
                    // The learner answered this question; that alone must not withhold its figure.
                    student_answer_present: true,
                    ...(optionClaim ? {} : { figure_ids: [0] }),
                    options: [
                      {
                        label: optionClaim ? expected.optionLabel : 'A',
                        text: '30°',
                        ...(optionClaim ? { figure_ids: [0] } : {}),
                      },
                      { label: 'B', text: '60°' },
                    ],
                  },
                ],
              }),
            }),
          }),
      });
      const block = await runHandler(handler, sessionId);
      const { rows } = await readIngestionSessionBlocks(db, { id: sessionId });
      expect(IngestionBlocksResponseSchema.safeParse({ rows }).success).toBe(true);
      expect(block.figures?.map((figure) => figure.contains_learner_handwriting)).toEqual(
        expected.marker === null ? [] : [expected.marker],
      );
      if (expected.marker === null) continue;
      if (!block.source_document_id) throw new Error('block has no source document');

      const enrolled = await enrollBlockIntoItemBank({
        db,
        block,
        knowledgeIds: [],
        difficulty: 3,
        confidence: 0.9,
        markers: {
          enrolled_by: 'workflow_judge',
          knowledge: 'missing',
          confidence: 0.9,
          figures_attached: block.figures.length,
          student_work: true,
        },
        sourceDocumentId: block.source_document_id,
        now: new Date(),
        generatedBy: 'workflow_judge',
      });
      if (!enrolled) throw new Error('block was not enrolled');
      await expectModelReadersSee(enrolled.question_id, expected.marker);
    }
  } finally {
    __setPiAdapterForTests(undefined);
    resetTestConfig();
  }
});

// @invariant security: the Tencent OCR path crops QuestionImagePositions and binds a crop that overlaps learner handwriting, marked true, when the structure model is unavailable
// @fails-if the Tencent parser never crops, the OCR fallback withholds a figure because its question has handwriting, or the overlap is not marked as learner handwriting
it('crops Tencent figure positions and keeps a handwritten crop marked on the OCR fallback', async () => {
  const { sessionId } = await seedIngestionSession(1);
  const handler = buildTencentOcrHandler({
    db,
    r2: await storingR2(),
    engine: 'tencent',
    submitFn: vi.fn(async () => 'figure-job'),
    describeFn: vi.fn(
      async (): Promise<DescribeResponse> => ({ ...tencentFigure, JobStatus: 'DONE' }),
    ),
    runStructureFn: async () => {
      throw new StructureTaskError('structure model unavailable');
    },
  });
  const block = await runHandler(handler, sessionId);
  expect(block.figures?.map((figure) => figure.contains_learner_handwriting)).toEqual([true]);
  const [crop] = block.figures ?? [];
  expect(objects.has(`figures/${crop?.asset_id}.png`)).toBe(true);
});
