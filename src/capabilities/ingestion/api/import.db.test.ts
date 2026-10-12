import { ingestionCapability } from '@/capabilities/ingestion/manifest';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
/**
 * Tests for POST /api/ingestion/[id]/import
 *
 * Strategy:
 * - Use testDb() / resetDb() for actual Postgres integration
 * - Mock @/server/ai/runner except the DOCX recovery case (real Pi loop, offline provider)
 * - Lane D (YUK-482): the failure→propose-new-KC side-effect was removed from
 *   import; these tests assert only canonical capture facts are written. The
 *   practice-owned durable subscription derives failure learning afterwards.
 */

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  event,
  job_events,
  knowledge,
  learning_record,
  learning_session,
  question,
  question_block,
  source_asset,
  source_document,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';

const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(async () => ({
    task_run_id: 'x',
    text: '{}',
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  })),
}));

import { createHash } from 'node:crypto';
import { agentLoop } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  type Model,
  createAssistantMessageEventStream,
  createModels,
} from '@earendil-works/pi-ai';
import { strToU8, zipSync } from 'fflate';
import sharp from 'sharp';
import type { TaskRuntime } from '@/ai/task-runtime';
import { DocxAgentState } from '@/core/schema/docx-agent';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { buildPiDomainAgentTools } from '@/server/ai/tools/pi-tools';
import { Ingestion } from '@/server/session';
// YUK-503 (YUK-471 W3-D test hardening) — fold==row parity helpers for the set_status writers.
// The import POST emits a canonical `experimental:question_block_lifecycle` (op='set_status') alongside
// each imperative status UPDATE; these let the test prove the additive double-write keeps the event-log
// fold byte-identical to the live row (catching a future ONE-SIDED literal drift between the UPDATE and
// the lifecycle-event payload, which the existing behavioural assertions on `block.status` would miss).
import {
  type IngestionOperationJobData,
  buildIngestionOperationHandler,
} from '../jobs/ingestion_operation';
import { buildTencentOcrHandler } from '../jobs/tencent_ocr_extract';
import { runAutoEnrollForSession } from '../server/auto-enroll';
import { prepareDocxForConversion } from '../server/docx/route-classify';
import { persistDocxSourcePackage } from '../server/docx/source-package';
import * as enrollment from '../server/enroll';
import { completeIngestionImport } from '../server/import-completion';
import { readIngestionOperation, reserveIngestionOperation } from '../server/operation-store';
import { ImportBody } from './import-schema';

// ---- helpers ----

async function setupSession(
  db: ReturnType<typeof testDb>,
  opts: {
    sessionId?: string;
    status?: string;
    assetIds?: string[];
  } = {},
) {
  const sessionId = opts.sessionId ?? createId();
  const assetIds = opts.assetIds ?? ['asset_1'];
  const now = new Date();

  // Insert source_assets
  for (const assetId of assetIds) {
    await db.insert(source_asset).values({
      id: assetId,
      kind: 'image',
      storage_key: `sk_${assetId}`,
      mime_type: 'image/png',
      byte_size: 8,
      sha256: '0'.repeat(64),
      created_at: now,
    });
  }

  const sourceDocId = createId();
  await db.insert(source_document).values({
    id: sourceDocId,
    title: null,
    source_asset_ids: assetIds,
    body_md: null,
    provenance: {} as Record<string, unknown>,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocId,
    source_asset_ids: assetIds,
    status: opts.status ?? 'extracted',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  return { sessionId, sourceDocId };
}

async function insertBlock(
  db: ReturnType<typeof testDb>,
  opts: {
    id: string;
    sessionId: string;
    docId: string;
    status?: string;
    visual_complexity?: string;
    ordinal?: number;
  },
) {
  const now = new Date();
  await db.insert(question_block).values({
    id: opts.id,
    ingestion_session_id: opts.sessionId,
    source_document_id: opts.docId,
    source_asset_ids: ['asset_1'],
    page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
    ordinal: opts.ordinal ?? 0,
    extracted_prompt_md: 'Q text',
    reference_md: null,
    wrong_answer_md: null,
    image_refs: ['asset_1'],
    crop_refs: [],
    visual_complexity: opts.visual_complexity ?? 'low',
    extraction_confidence: 0.9,
    status: opts.status ?? 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_attempt_event_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function insertKnowledge(db: ReturnType<typeof testDb>, id: string, domain = 'yuwen') {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain,
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function makeImportBody(overrides: Record<string, unknown> = {}) {
  return {
    blocks: [
      {
        block_id: 'block_a',
        source_block_ids: ['block_a'],
        page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
        image_refs: ['asset_1'],
        final_prompt_md: 'Q final',
        final_reference_md: null,
        final_wrong_answer_md: 'WA',
        knowledge_ids: ['k1'],
        cause: null,
        difficulty: 3,
        question_kind: 'short_answer',
        ...overrides,
      },
    ],
  };
}

describe('POST /api/ingestion/[id]/import', () => {
  afterEach(() => {
    __setPiAdapterForTests(undefined);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
    vi.clearAllMocks();
  });

  // @invariant data: DOCX sources and staged drafts survive agent failure/retry without duplicate or silent-drop imports.
  // @fails-if a task can access foreign material, failures erase staged drafts, retry duplicates questions, or unresolved material becomes a terminal import.
  it('retains DOCX agent material and drafts through budget rejection and retry', async () => {
    const db = testDb();
    // Production worker boot registers capability tools before dispatching jobs.
    await registerCapabilityTools([ingestionCapability]);
    const markdown = '题甲：选择正确项。\nA.甲 B.乙\n题乙：看图回答。';
    const original = zipSync({
      '[Content_Types].xml': strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      'word/document.xml': strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>synthetic</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    // The converter is the external boundary. Storage, PDF rendering, workspace,
    // registry tools, transactions, canonical events and import are all real.
    const pdf = strToU8(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    );
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#234567' },
    })
      .png()
      .toBuffer();
    const source = await persistDocxSourcePackage(
      db,
      r2,
      {
        docxToMarkdown: async () => ({
          markdown,
          media: [{ path: '../untrusted-image.png', bytes: png }],
        }),
        docxToPdf: async () => pdf,
      },
      original,
      prepareDocxForConversion(original),
    );
    const { sessionId, sourceDocumentId } = await Ingestion.initiateUpload(db, {
      assetIds: source.pages.assetIds,
      entrypoint: 'docx',
      docxSource: { package: source.package, markdown },
    });
    const foreign = await setupSession(db, { assetIds: ['foreign-page'] });
    await insertBlock(db, {
      id: 'foreign-block',
      sessionId: foreign.sessionId,
      docId: foreign.sourceDocId,
    });
    const queue = async () =>
      Ingestion.enqueueExtraction({
        db,
        sessionId,
        boss: { send: async () => 'local-docx-job' } as never,
      });
    const page = source.pages.assetIds[0];
    const media = source.package.files.find((f) => f.role === 'media')?.asset_id ?? '';
    const text = source.package.files.find((f) => f.role === 'markdown')?.asset_id ?? '';
    const region = { x: 0, y: 0, width: 1, height: 1 };
    const draft = (key: string, prompt: string) => ({
      key,
      structured: {
        id: key,
        role: 'standalone',
        question_no: key,
        prompt_text: prompt,
        kind: 'short_answer',
        options:
          key === 'q1'
            ? [
                { label: 'A', text: '甲' },
                { label: 'B', text: '乙' },
              ]
            : undefined,
      },
      page_spans: [{ page_index: 0, bbox: region }],
      figures: [],
      unresolved: prompt ? [] : ['image-only prompt unresolved'],
      confidence: 0.7,
    });
    // Real central runner + PiAgentAdapter + agentLoop. Only provider streaming
    // is controlled: no HTTP request and no paid model. Existing run logs remain live.
    const { runTask: actualRunTask } =
      await vi.importActual<typeof import('@/server/ai/runner')>('@/server/ai/runner');
    const runtime: TaskRuntime = {
      runTask: actualRunTask,
      buildDomainTools: buildPiDomainAgentTools,
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T04:00:00Z'));
    vi.stubEnv('XIAOMI_API_KEY', 'offline-provider-test-only');
    const approve = (maxRunUsd: number) =>
      vi.stubEnv(
        'DOCX_AGENT_BUDGET_APPROVAL',
        JSON.stringify({
          priceRef: 'xiaomi-overseas-usd/2026-10-08',
          provider: 'xiaomi',
          model: 'mimo-v2.5',
          currency: 'USD',
          maxRunUsd,
          expiresAt: '2026-10-13T00:00:00Z',
        }),
      );
    approve(1);
    const model: Model<'openai-completions'> = {
      id: 'mimo-v2.5',
      name: 'Offline DOCX wire',
      provider: 'xiaomi',
      api: 'openai-completions',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 1_048_576,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const models = createModels();
    vi.spyOn(models, 'getModel').mockReturnValue(model);
    let phase: 'unknown_usage' | 'image_bound' | 'resume' = 'unknown_usage';
    let turn = 0,
      revision = 0,
      secondBlockId = '';
    const wire = vi.spyOn(models, 'streamSimple').mockImplementation((_model, context, options) => {
      vi.setSystemTime(new Date(Date.now() + 10)); // Keep canonical event ordering while pinning the dated price fixture.
      expect(options?.maxTokens).toBe(4096);
      expect(options?.maxRetries).toBe(0);
      const fail = phase !== 'resume';
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const previous = [...context.messages].reverse().find((m) => m.role === 'toolResult');
        const previousText =
          previous?.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('') ?? '';
        const output = () => JSON.parse(previousText).output;
        const tool = (name: string, args: Record<string, unknown>): AssistantMessage['content'] => [
          {
            type: 'toolCall',
            id: createId(),
            name: `mcp__loom__${name}`,
            arguments: JSON.parse(JSON.stringify(args)),
          },
        ];
        let content: AssistantMessage['content'];
        switch (turn++) {
          case 0:
            content = tool('read_docx_source', { action: 'list' });
            break;
          case 1:
            expect(output().files).toHaveLength(6);
            content = tool('read_docx_source', { action: 'text', asset_id: '../foreign-page' });
            break;
          case 2:
            expect(previousText).toContain('outside');
            content = tool('update_prompt', {
              block_id: 'foreign-block',
              node_id: 'foreign',
              prompt_text: 'overwrite',
            });
            break;
          case 3:
            expect(previous?.isError).toBe(true);
            expect(previousText).toContain('outside');
            content = tool('read_docx_source', { action: 'text', asset_id: text });
            break;
          case 4:
            content = tool('edit_docx_drafts', { action: 'inspect' });
            break;
          case 5: {
            const initial = output().state;
            if (!fail)
              expect(
                initial.questions.find((q: { key: string }) => q.key === 'q2').structured
                  .prompt_text,
              ).toBe('已通过现有工具修订');
            content = tool('edit_docx_drafts', {
              action: 'upsert',
              expected_revision: initial.revision,
              questions: fail ? [draft('q1', '题甲'), draft('q2', '题乙')] : [draft('q2', '')],
              ...(!fail
                ? {
                    coverage: [
                      {
                        asset_id: page,
                        question_keys: ['q1', 'q2'],
                        disposition: 'unresolved',
                        reason: '视觉预算未批准，页图未核对',
                      },
                      {
                        asset_id: media,
                        question_keys: [],
                        disposition: 'unresolved',
                        reason: '图片归属不确定',
                      },
                    ],
                  }
                : {}),
            });
            break;
          }
          case 6:
            revision = output().revision;
            secondBlockId = output().blocks.find((b: { key: string }) => b.key === 'q2').block_id;
            content = fail
              ? tool('update_prompt', {
                  block_id: secondBlockId,
                  node_id: 'q2',
                  prompt_text: '已通过现有工具修订',
                })
              : tool('edit_docx_drafts', { action: 'check' });
            break;
          case 7:
            if (fail) {
              await buildTencentOcrHandler({
                db,
                r2,
                taskRuntime: {
                  ...runtime,
                  runTask: async () => {
                    throw new Error('duplicate reached runner');
                  },
                },
              })([job]);
              content = tool('read_docx_source', { action: 'image', asset_id: page });
            } else {
              expect(output().gaps.length).toBeGreaterThan(0);
              content = tool('edit_docx_drafts', { action: 'commit', expected_revision: revision });
            }
            break;
          case 8:
            expect(phase).toBe('resume'); // No provider request may follow missing usage or a native image result.
            expect(output().sealed).toBe(true);
            content = [{ type: 'text', text: 'Partial draft batch saved' }];
            break;
          default:
            throw new Error('offline provider script exhausted');
        }
        const message: AssistantMessage = {
          role: 'assistant',
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: phase === 'unknown_usage' && turn === 8 ? 0 : 1000,
            output: phase === 'unknown_usage' && turn === 8 ? 0 : 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: phase === 'unknown_usage' && turn === 8 ? 0 : 1010,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: content[0]?.type === 'toolCall' ? 'toolUse' : 'stop',
        };
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
      })().catch((error: Error) => {
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'error',
          errorMessage: error.message,
        };
        stream.push({ type: 'error', reason: 'error', error: message });
      });
      return stream;
    });
    __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));
    const job = { id: 'local-docx-job', data: { sessionId } } as never;
    const handler = buildTencentOcrHandler({ db, r2, taskRuntime: runtime });
    await queue();
    model.baseUrl = 'https://unpriced.invalid';
    await expect(handler([job])).rejects.toThrow('unpriced or changed');
    expect(wire).not.toHaveBeenCalled();
    model.baseUrl = 'https://api.xiaomimimo.com/v1';
    approve(0.000001);
    await queue();
    await expect(handler([job])).rejects.toThrow('insufficient run budget');
    expect(wire).not.toHaveBeenCalled();
    approve(1);
    await queue();
    await expect(handler([job])).rejects.toThrow('unknown or out-of-bound provider usage');
    expect(wire).toHaveBeenCalledTimes(8);
    expect(
      (await db.select().from(learning_session).where(eq(learning_session.id, sessionId)))[0]
        .status,
    ).toBe('failed');
    expect(
      await db
        .select()
        .from(question_block)
        .where(eq(question_block.ingestion_session_id, sessionId)),
    ).toHaveLength(2);
    const [interrupted] = await db
      .select()
      .from(source_document)
      .where(eq(source_document.id, sourceDocumentId));
    const reservations = interrupted.provenance.docx_request_budget as Array<{
      status: string;
      amountMicros: number;
      reservedMicros: number;
    }>;
    expect(reservations.find((entry) => entry.status === 'unknown')).toMatchObject({
      amountMicros: 147948,
      reservedMicros: 147948,
    });
    phase = 'image_bound';
    turn = 0;
    await queue();
    await expect(handler([job])).rejects.toThrow('unknown image token upper bound');
    expect(wire).toHaveBeenCalledTimes(16);
    expect(
      await db
        .select()
        .from(question_block)
        .where(eq(question_block.ingestion_session_id, sessionId)),
    ).toHaveLength(2);
    phase = 'resume';
    turn = 0;
    await queue();
    await handler([job]);
    await handler([job]); // Completed queue delivery is idempotent.
    expect(wire).toHaveBeenCalledTimes(25);
    const drafts = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId))
      .orderBy(question_block.ordinal);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].structured?.options?.map((o) => o.label)).toEqual(['A', 'B']);
    const [saved] = await db
      .select()
      .from(source_document)
      .where(eq(source_document.id, sourceDocumentId));
    expect(saved.body_md).toBe(markdown);
    expect(saved.source_asset_ids).toHaveLength(6);
    for (const file of source.package.files) {
      const [asset] = await db
        .select()
        .from(source_asset)
        .where(eq(source_asset.id, file.asset_id));
      const bytes = await r2.get(asset.storage_key);
      if (!bytes) throw new Error('Persisted source bytes missing');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect(DocxAgentState.parse(saved.provenance.docx_agent).sealed).toBe(true);
    await insertKnowledge(db, 'k1');
    const request = (row: (typeof drafts)[number]) =>
      ImportBody.parse(
        makeImportBody({
          block_id: row.id,
          source_block_ids: [row.id],
          image_refs: row.image_refs,
          page_spans: row.page_spans,
          final_prompt_md: row.structured ? structuredToPromptMarkdown(row.structured) : '',
          outcome: 'unanswered',
          final_wrong_answer_md: '',
        }),
      );
    await expect(completeIngestionImport(db, sessionId, request(drafts[1]))).rejects.toThrow();
    await expect(completeIngestionImport(db, sessionId, request(drafts[0]))).rejects.toThrow(
      'unresolved material',
    );
    expect(await db.select().from(question)).toHaveLength(0);
    const [open] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(open.status).toBe('partial');
    const retained = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(retained.map((b) => b.status)).toEqual(['draft', 'draft']);
    expect(DocxAgentState.parse(saved.provenance.docx_agent).seen_images).toEqual([]);
  });

  it('durable import calls the owner once across concurrent delivery and replay', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');
    const operationId = 'ingop_duplicate_import';
    await reserveIngestionOperation(db, {
      operationId,
      sessionId,
      operationKind: 'import',
      inputHash: 'test-input',
    });
    const jobs = [
      {
        id: 'job-import',
        data: {
          operationId,
          sessionId,
          request: { kind: 'import', input: ImportBody.parse(makeImportBody()) },
        },
      },
    ] as Job<IngestionOperationJobData>[];
    const handler = buildIngestionOperationHandler(db);
    await Promise.all([handler(jobs), handler(jobs)]);
    const receipt = await readIngestionOperation(db, operationId);
    expect(receipt).toMatchObject({
      status: 'succeeded',
      result: {
        question_ids: [expect.any(String)],
        mistake_ids: [expect.any(String)],
        record_ids: [expect.any(String)],
      },
    });
    await handler(jobs);
    expect(await readIngestionOperation(db, operationId)).toEqual(receipt);
    expect(await db.select().from(question)).toHaveLength(1);
    expect(await db.select().from(learning_record)).toHaveLength(1);
    const completed = await db
      .select()
      .from(job_events)
      .where(
        and(
          eq(job_events.business_id, operationId),
          eq(job_events.event_type, 'operation.completed'),
        ),
      );
    expect(completed).toHaveLength(1);
    const [session] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session.status).toBe('imported');
  });

  it('manual import and auto-enroll cannot consume the same source block concurrently', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');
    await db
      .update(question_block)
      .set({
        structured: {
          id: 'structured-a',
          role: 'standalone',
          prompt_text: '解释下列句子中之字的用法，并指出代词与结构助词的区别。',
          source: 'vlm_structure',
        },
        layout_quality: 'structured',
      })
      .where(eq(question_block.id, 'block_a'));
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const realEnroll = enrollment.enrollCapturedBlock;
    const enrollmentSpy = vi
      .spyOn(enrollment, 'enrollCapturedBlock')
      .mockImplementationOnce(async (tx, input) => {
        // Manual path has validated the source and inserted its question, but has
        // not yet written the block's terminal status: the historical double-consume gap.
        paused.resolve();
        await release.promise;
        return realEnroll(tx, input);
      });
    const manual = completeIngestionImport(db, sessionId, ImportBody.parse(makeImportBody()));
    await paused.promise;
    let autoFinished = false;
    const automatic = runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'yuwen',
      env: { WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: 'true' },
      tagKnowledgeFn: async () => ({ kind: 'match', knowledge_ids: ['k1'] }),
    }).finally(() => {
      autoFinished = true;
    });
    try {
      // Wait for the actual database lock wait (fixed path), or completion (old
      // path), not a guessed sleep duration. Then let manual import settle.
      await vi.waitFor(
        async () => {
          const [waiter] = await db.execute(sql`SELECT EXISTS(
          SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND objid = hashtext('learning-state:write')::oid
        ) AS blocked`);
          expect(autoFinished || waiter.blocked === true).toBe(true);
        },
        { timeout: 5_000, interval: 10 },
      );
      release.resolve();
      const [, result] = await Promise.all([manual, automatic]);
      expect(await db.select().from(question)).toHaveLength(1);
      expect(await db.select().from(learning_record)).toHaveLength(1);
      expect(await db.select().from(event).where(eq(event.action, 'attempt'))).toHaveLength(1);
      expect(result.enrolled).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([manual, automatic]);
      enrollmentSpy.mockRestore();
    }
  });

  // Codex P1-A — concurrent double-submit must not produce partial side effects.
  // The status-machine check (commitImport) and the write phase must live inside
  // a single transaction; otherwise both callers may pass per-row checks, both
  // INSERT question/mistake/question_block rows, and only one wins the
  // status-transition fight in commitImport — leaving the other call's writes
  // committed and orphaned (and the user observing duplicate imports on retry).
  it('concurrent double-submit: exactly one import succeeds, no partial side effects', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const results = await Promise.allSettled([
      completeIngestionImport(db, sessionId, ImportBody.parse(makeImportBody())),
      completeIngestionImport(db, sessionId, ImportBody.parse(makeImportBody())),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'conflict', status: 409 },
    });

    // Exactly one question and one attempt event were inserted (the winning import).
    // Step 9 dropped the mistake table — the attempt event id doubles as the
    // back-compat mistake_id.
    const questions = await db.select().from(question);
    const attemptEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.outcome, 'failure')));
    expect(questions).toHaveLength(1);
    expect(attemptEvents).toHaveLength(1);

    // Block was promoted from draft → imported exactly once.
    const blocks = await db.select().from(question_block).where(eq(question_block.id, 'block_a'));
    expect(blocks[0].status).toBe('imported');

    // Session reached terminal `imported` state.
    const sessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(sessions[0].status).toBe('imported');
  });
});
