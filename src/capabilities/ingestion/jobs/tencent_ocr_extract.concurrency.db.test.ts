import {
  type AssistantMessage,
  type Context,
  type Model,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { reserveIngestionOperation } from '@/capabilities/ingestion/server/operation-store';
import { TencentSubmitInProgressError } from '@/capabilities/ingestion/server/provider-attempts';
import type { DescribeResponse } from '@/capabilities/ingestion/server/tencent_mark';
import { installPracticeHost } from '@/capabilities/practice/public';
import { loadGradedContract } from '@/capabilities/practice/question-bank/jobs/question_admission_run';
import {
  definitionFromContract,
  runQuestionAdmission,
} from '@/capabilities/practice/question-bank/server/admission';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { db } from '@/db/client';
import {
  learning_session,
  provider_attempt,
  question_block,
  question_group_lifecycle,
} from '@/db/schema';
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

const LEARNER_HANDWRITING_RULE = '图中手写是学习者的作答，可能是错的，不要当作答案或条件';

// @invariant security: every attributable crop of a question with learner work reaches blind solve, carrying its per-crop learner-handwriting marker and the rule that handwriting is not a condition or answer
// @fails-if a whole-question handwriting veto drops the crop, a handwritten or undecided crop is withheld, the marker is lost between OCR and the provider request, or the solve prompt omits the handwriting rule
it('sends every question figure to blind solve with its learner-handwriting marker', async () => {
  vi.stubEnv('OPENCODE_API_KEY', 'synthetic-fixture-key');
  vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
  vi.stubEnv('AI_PROVIDER_MODEL', '');
  setTestConfig({
    'task.QuestionAdmissionSolveTask.provider': 'opencode-go',
    'task.QuestionAdmissionSolveTask.model': solverModel.id,
    'task.QuestionAdmissionSolveTask.override_global_pin': true,
  });
  const cases: Array<{
    judgment: boolean | null | undefined;
    optionLabel: string | null;
    marker: boolean | 'unknown' | null;
  }> = [
    { judgment: false, optionLabel: null, marker: false },
    { judgment: true, optionLabel: null, marker: true },
    { judgment: null, optionLabel: null, marker: 'unknown' },
    // An omitted judgment must not fail the whole StructureOutput parse.
    { judgment: undefined, optionLabel: 'A', marker: 'unknown' },
    // FigureRef.option_label.min(1): an empty option label claim stays unbound.
    { judgment: false, optionLabel: '', marker: null },
  ];
  try {
    for (const expected of cases) {
      const { sessionId } = await seedIngestionSession(1);
      const optionClaim = expected.optionLabel !== null;
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
      const [lifecycle] = await db
        .select()
        .from(question_group_lifecycle)
        .where(eq(question_group_lifecycle.group_id, enrolled.question_id));
      const { contract } = await loadGradedContract(
        db,
        enrolled.question_id,
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
      expect(JSON.stringify(content)).toContain(`contains_learner_handwriting: ${expected.marker}`);
      const system = solveRequest.messages.find((message) => (message.role as string) === 'system');
      expect(JSON.stringify(system?.content)).toContain(LEARNER_HANDWRITING_RULE);
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
