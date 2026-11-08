import {
  type AssistantMessage,
  type Model,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reserveIngestionOperation } from '@/capabilities/ingestion/server/operation-store';
import type { DescribeResponse } from '@/capabilities/ingestion/server/tencent_mark';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { db } from '@/db/client';
import { question, question_block } from '@/db/schema';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { type PiAdapterDeps, PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import tencentDone from '../../../../tests/fixtures/tencent_mark_agent_cloze_sample.json';
import { resetDb } from '../../../../tests/helpers/db';
import { enrollBlockIntoItemBank } from '../server/item-bank-enrollment';
import { createImageR2, seedIngestionSession } from './ingestion-test-support';
import { buildTencentOcrHandler } from './tencent_ocr_extract';

const model: Model<'openai-completions'> = {
  id: 'deepseek-v4.1-flash',
  name: 'offline',
  provider: 'opencode-go',
  api: 'openai-completions',
  baseUrl: 'https://offline.invalid',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 262144,
  maxTokens: 32768,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

// Page 0 is math and page 1 physics; the stem spans both, so its pages disagree.
const structureOutput = {
  layout_quality: 'structured',
  extraction_confidence: 0.9,
  warnings: [],
  content_lost: false,
  page_subjects: [
    { page_index: 0, subject_id: 'math' },
    { page_index: 1, subject_id: 'physics' },
    { page_index: 1, subject_id: 'chemistry-not-known' },
  ],
  questions: [
    { role: 'standalone', question_no: '1', prompt_text: '求 $x^2=4$ 的解。', page_index: 0 },
    {
      role: 'stem',
      question_no: '2',
      prompt_text: '阅读材料回答问题。',
      page_index: 0,
      sub_questions: [
        { role: 'sub', question_no: '1', prompt_text: '第一问', page_index: 0 },
        { role: 'sub', question_no: '2', prompt_text: '第二问', page_index: 1 },
      ],
    },
    { role: 'standalone', question_no: '3', prompt_text: '一物体做匀速直线运动……', page_index: 1 },
  ],
};

beforeEach(async () => {
  vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'observe');
  vi.stubEnv('OPENCODE_API_KEY', 'synthetic-fixture-key');
  vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
  vi.stubEnv('AI_PROVIDER_MODEL', '');
  await resetDb();
});
afterEach(() => {
  __setPiAdapterForTests(undefined);
  resetTestConfig();
  vi.unstubAllEnvs();
});

// @invariant grading: the subject admission later freezes is exactly the known subject StructureTask reported for every page the question spans, carried from the real runner through extraction into enrollment metadata
// @fails-if known_subjects never reaches the model, page_subjects is dropped by parsing, an unknown or conflicting page subject is enrolled, or the subject is not written to metadata.ingestion_enrollment.subject_id
it('writes StructureTask page subjects into enrollment metadata through the real runner', async () => {
  setTestConfig({
    'task.StructureTask.provider': 'opencode-go',
    'task.StructureTask.model': model.id,
    'task.StructureTask.reasoning': { level: 'none' },
    'task.StructureTask.override_global_pin': true,
  });
  const contexts: string[] = [];
  const streamSimple: NonNullable<PiAdapterDeps['models']>['streamSimple'] = (_model, context) => {
    contexts.push(JSON.stringify(context.messages));
    const message: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: 'text', text: JSON.stringify(structureOutput) }],
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0.000001, output: 0.000001, cacheRead: 0, cacheWrite: 0, total: 0.000002 },
      },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  };
  __setPiAdapterForTests(new PiAgentAdapter({ models: { getModel: () => model, streamSimple } }));

  const { sessionId, operationId } = await seedIngestionSession(2);
  await reserveIngestionOperation(db, {
    sessionId,
    operationId,
    operationKind: 'extract',
    inputHash: `hash-${operationId}`,
  });
  let submitted = 0;
  const handler = buildTencentOcrHandler({
    db,
    r2: await createImageR2(),
    engine: 'tencent',
    submitFn: vi.fn(async () => `ocr-job-${submitted++}`),
    describeFn: vi.fn(
      async (): Promise<DescribeResponse> => ({ ...tencentDone, JobStatus: 'DONE' }),
    ),
  });
  await handler([
    {
      id: 'structure-subject-job',
      data: { sessionId, operationId },
      retryCount: 0,
      retryLimit: 2,
      startedOn: new Date(),
    },
  ] as never);

  const blocks = await db
    .select()
    .from(question_block)
    .where(eq(question_block.ingestion_session_id, sessionId))
    .orderBy(asc(question_block.ordinal));
  const enrolledSubjects: Array<unknown> = [];
  for (const block of blocks) {
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
        student_work: false,
      },
      sourceDocumentId: block.source_document_id ?? '',
      now: new Date(),
      generatedBy: 'workflow_judge',
    });
    const [row] = await db
      .select({ metadata: question.metadata })
      .from(question)
      .where(eq(question.id, enrolled?.question_id ?? ''));
    enrolledSubjects.push(
      (row?.metadata?.ingestion_enrollment as { subject_id?: unknown } | undefined)?.subject_id,
    );
  }

  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toContain('known_subjects');
  expect(contexts[0]).toMatch(/\\"id\\":\\"math\\"/);
  expect(contexts[0]).toMatch(/\\"id\\":\\"physics\\"/);
  expect(enrolledSubjects).toEqual(['math', undefined, 'physics']);
});
