import { Hono } from 'hono';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { runTask } from '../ai/runner';
import { runOCRCascade } from '../ingestion/cascade';
import { recognizeDocument } from '../ingestion/ocr_tencent';
import { runProposeAndWrite } from '../knowledge/propose';
import { runAttributionAndWrite } from '../knowledge/attribute';
import { loadTreeSnapshot } from '../knowledge/tree';
import {
  CauseCategory,
  IngestionEntrypoint,
  QuestionKind,
} from '../../../src/core/schema/business';
import { PageSpan } from '../../../src/core/schema';
import type { AppEnv } from '../types';

type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

let runTaskFn: RunTaskFn = async (kind, input, ctx) => {
  const result = await runTask(kind, input, ctx as { env: AppEnv['Bindings'] });
  return { text: result.text };
};

export function setIngestionRunTaskForTests(fn: RunTaskFn) {
  runTaskFn = fn;
}

export const ingestion = new Hono<AppEnv>();

const Body = z.object({
  entrypoint: IngestionEntrypoint,
  asset_ids: z.array(z.string().min(1)).min(1).max(5),
});

ingestion.post('/', async (c) => {
  const raw = (await c.req.json().catch(() => null)) as unknown;
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'validation_error',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
      400,
    );
  }
  const body = parsed.data;

  // Validate all asset_ids exist in DB
  const assetRows: Array<{ id: string; storage_key: string; mime_type: string }> = [];
  const missingIds: string[] = [];
  for (const assetId of body.asset_ids) {
    const row = await c.env.DB.prepare(
      `select id, storage_key, mime_type from source_asset where id = ?`,
    )
      .bind(assetId)
      .first<{ id: string; storage_key: string; mime_type: string }>();
    if (!row) {
      missingIds.push(assetId);
    } else {
      assetRows.push(row);
    }
  }
  if (missingIds.length > 0) {
    return c.json(
      {
        error: 'validation_error',
        message: `unknown asset_ids: ${missingIds.join(', ')}`,
      },
      400,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const sourceDocId = createId();
  const sessionId = createId();

  await c.env.DB.prepare(
    `insert into source_document (id, title, source_asset_ids, body_md, provenance, created_at, updated_at, version) values (?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      sourceDocId,
      null,
      JSON.stringify(body.asset_ids),
      null,
      JSON.stringify({ entrypoint: body.entrypoint }),
      now,
      now,
    )
    .run();

  await c.env.DB.prepare(
    `insert into ingestion_session (id, source_document_id, source_asset_ids, status, entrypoint, error_message, created_at, updated_at, version) values (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      sessionId,
      sourceDocId,
      JSON.stringify(body.asset_ids),
      'uploaded',
      body.entrypoint,
      null,
      now,
      now,
    )
    .run();

  type BlockRow = {
    block_id: string;
    source_block_ids: string[];
    page_spans: Array<{ page_index: number; bbox: { x: number; y: number; width: number; height: number }; role: string }>;
    image_refs: string[];
    extracted_prompt_md: string;
    reference_md: string | null;
    wrong_answer_md: string | null;
    visual_complexity: string;
    extraction_confidence: number;
    knowledge_hint: string | null;
  };

  const blocks: BlockRow[] = [];
  const failures: Array<{ asset_id: string; reason: string }> = [];
  const perAssetTierLogs: Array<{
    asset_id: string;
    log: import('../ingestion/cascade').TierLogEntry[];
  }> = [];

  for (let i = 0; i < assetRows.length; i++) {
    const row = assetRows[i];
    const pageIndex = i;

    const r2Object = await c.env.IMAGES.get(row.storage_key);
    if (!r2Object) {
      console.error('ingestion: r2 object missing', { assetId: row.id, storageKey: row.storage_key });
      failures.push({ asset_id: row.id, reason: 'r2_object_missing' });
      continue;
    }

    const imageBytes = await r2Object.arrayBuffer();

    let extracted: { blocks: Array<{
      extracted_prompt_md: string;
      reference_md: string | null;
      wrong_answer_md: string | null;
      page_index: number;
      bbox: { x: number; y: number; width: number; height: number };
      role: 'prompt' | 'answer_area' | 'continuation';
      visual_complexity: 'low' | 'medium' | 'high';
      extraction_confidence: number;
      knowledge_hint: string | null;
    }> };
    let tierLogForAsset: import('../ingestion/cascade').TierLogEntry[] = [];
    try {
      const cascadeOut = await runOCRCascade({
        imageBytes,
        mimeType: row.mime_type,
        pageIndex,
        env: c.env,
        deps: {
          recognizeDocument,
          runTaskFn,
          // Image dimensions: Tencent needs pixel dims for normalization. Without
          // an image-decoder in the Worker we use a coarse bound that matches
          // the upload pipeline's max (8 MB / typical scan ~ 2480x3508 A4 @ 300dpi).
          // Tier 1 normalization tolerates this bound — bbox values are advisory and
          // user can re-edit on the review page.
          imageDimensions: { width: 2480, height: 3508 },
          now: () => Date.now(),
        },
      });
      extracted = { blocks: cascadeOut.blocks };
      tierLogForAsset = cascadeOut.tier_log;
      if (cascadeOut.final_status === 'failed') {
        failures.push({ asset_id: row.id, reason: 'all tiers exhausted' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('ingestion: runOCRCascade failed', { assetId: row.id, pageIndex, err: msg });
      failures.push({ asset_id: row.id, reason: msg });
      tierLogForAsset = [];
      continue;
    }

    perAssetTierLogs.push({ asset_id: row.id, log: tierLogForAsset });

    for (const block of extracted.blocks) {
      const blockId = createId();
      const pageSpans = [{ page_index: block.page_index, bbox: block.bbox, role: block.role }];

      await c.env.DB.prepare(
        `insert into question_block (id, ingestion_session_id, source_document_id, source_asset_ids, page_spans, extracted_prompt_md, reference_md, wrong_answer_md, image_refs, crop_refs, visual_complexity, extraction_confidence, status, knowledge_hint, merged_from_block_ids, imported_question_id, imported_mistake_id, created_at, updated_at, version) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
        .bind(
          blockId,
          sessionId,
          sourceDocId,
          JSON.stringify([row.id]),
          JSON.stringify(pageSpans),
          block.extracted_prompt_md,
          block.reference_md,
          block.wrong_answer_md,
          JSON.stringify([row.id]),
          JSON.stringify([]),
          block.visual_complexity,
          block.extraction_confidence,
          'draft',
          block.knowledge_hint,
          JSON.stringify([]),
          null,
          null,
          now,
          now,
        )
        .run();

      blocks.push({
        block_id: blockId,
        source_block_ids: [blockId],
        page_spans: pageSpans,
        image_refs: [row.id],
        extracted_prompt_md: block.extracted_prompt_md,
        reference_md: block.reference_md,
        wrong_answer_md: block.wrong_answer_md,
        visual_complexity: block.visual_complexity,
        extraction_confidence: block.extraction_confidence,
        knowledge_hint: block.knowledge_hint,
      });
    }
  }

  const finalStatus = blocks.length === 0 ? 'failed' : 'extracted';
  const tierLogPayload =
    perAssetTierLogs.length > 0 || failures.length > 0
      ? JSON.stringify({ tier_logs: perAssetTierLogs, failures })
      : null;

  const updatedAt = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `update ingestion_session set status = ?, error_message = ?, updated_at = ?, version = version + 1 where id = ?`,
  )
    .bind(finalStatus, tierLogPayload, updatedAt, sessionId)
    .run();

  return c.json({
    session: {
      id: sessionId,
      source_document_id: sourceDocId,
      status: finalStatus,
      source_asset_ids: body.asset_ids,
      entrypoint: body.entrypoint,
      created_at: now,
      updated_at: updatedAt,
    },
    blocks,
  });
});

// =================== POST /:id/import ===================

const ImportBlock = z.object({
  block_id: z.string().min(1).optional(),
  source_block_ids: z.array(z.string().min(1)).min(1),
  page_spans: z.array(PageSpan).min(1),
  image_refs: z.array(z.string().min(1)),
  final_prompt_md: z.string().min(1),
  final_reference_md: z.string().nullable(),
  final_wrong_answer_md: z.string().min(1),
  knowledge_ids: z.array(z.string().min(1)).min(1),
  cause: z
    .object({
      primary_category: CauseCategory,
      user_notes: z.string().nullable(),
    })
    .nullable(),
  difficulty: z.number().int().min(1).max(5).default(3),
  question_kind: QuestionKind,
});

const ImportBody = z.object({
  blocks: z.array(ImportBlock).min(1),
});

type SessionRow = {
  id: string;
  source_document_id: string | null;
  source_asset_ids: string;
  status: string;
  entrypoint: string;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  version: number;
};

type QuestionBlockSelectRow = {
  id: string;
  ingestion_session_id: string;
  source_document_id: string | null;
  source_asset_ids: string;
  page_spans: string;
  extracted_prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string | null;
  image_refs: string;
  crop_refs: string;
  visual_complexity: string;
  extraction_confidence: number;
  status: string;
  knowledge_hint: string | null;
  merged_from_block_ids: string;
  imported_question_id: string | null;
  imported_mistake_id: string | null;
  created_at: number;
  updated_at: number;
  version: number;
};

ingestion.post('/:id/import', async (c) => {
  const sessionId = c.req.param('id');
  const raw = (await c.req.json().catch(() => null)) as unknown;
  const parsed = ImportBody.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'validation_error',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
      400,
    );
  }
  const body = parsed.data;

  // 1. Validate session exists and is in an importable state
  const session = await c.env.DB.prepare(`select * from ingestion_session where id = ?`)
    .bind(sessionId)
    .first<SessionRow>();
  if (!session) {
    return c.json({ error: 'not_found', message: `ingestion_session ${sessionId} not found` }, 404);
  }
  if (session.status !== 'extracted' && session.status !== 'reviewed') {
    return c.json(
      {
        error: 'conflict',
        message: `ingestion_session ${sessionId} is in status '${session.status}'; only 'extracted' or 'reviewed' can be imported`,
      },
      409,
    );
  }

  const sessionAssetIds = JSON.parse(session.source_asset_ids) as string[];
  const sessionAssetSet = new Set(sessionAssetIds);

  // 2. Validate every source_block_id belongs to this session, and block_id (if present) is in source_block_ids
  const sourceBlockRows = new Map<string, QuestionBlockSelectRow>();
  const allSourceIds = new Set<string>();
  for (const block of body.blocks) {
    for (const sid of block.source_block_ids) allSourceIds.add(sid);
    if (block.block_id !== undefined && !block.source_block_ids.includes(block.block_id)) {
      return c.json(
        {
          error: 'validation_error',
          message: `block_id ${block.block_id} must be in its source_block_ids`,
        },
        400,
      );
    }
  }
  for (const sid of allSourceIds) {
    const row = await c.env.DB.prepare(`select * from question_block where id = ?`)
      .bind(sid)
      .first<QuestionBlockSelectRow>();
    if (!row) {
      return c.json(
        { error: 'validation_error', message: `unknown source_block_id: ${sid}` },
        400,
      );
    }
    if (row.ingestion_session_id !== sessionId) {
      return c.json(
        {
          error: 'validation_error',
          message: `source_block_id ${sid} does not belong to session ${sessionId}`,
        },
        400,
      );
    }
    sourceBlockRows.set(sid, row);
  }

  // 3. Validate image_refs belong to session.source_asset_ids
  for (const block of body.blocks) {
    for (const ref of block.image_refs) {
      if (!sessionAssetSet.has(ref)) {
        return c.json(
          {
            error: 'validation_error',
            message: `image_ref ${ref} not in session source_asset_ids`,
          },
          400,
        );
      }
    }
  }

  // 3b. Validate page_spans page_index against session asset count
  for (const block of body.blocks) {
    for (const span of block.page_spans) {
      if (span.page_index >= sessionAssetIds.length) {
        return c.json(
          {
            error: 'validation_error',
            message: `page_index ${span.page_index} out of range (session has ${sessionAssetIds.length} assets)`,
          },
          400,
        );
      }
    }
  }

  // 4. Validate knowledge_ids
  for (const block of body.blocks) {
    for (const kid of block.knowledge_ids) {
      const k = await c.env.DB.prepare(
        `select id from knowledge where id = ? and archived_at is null`,
      )
        .bind(kid)
        .first();
      if (!k) {
        return c.json(
          {
            error: 'validation_error',
            message: `unknown or archived knowledge_id: ${kid}`,
          },
          400,
        );
      }
    }
  }

  // ---- All validation passed; build and execute batch ----
  const now = Math.floor(Date.now() / 1000);

  // Pre-compute the set of block_ids being imported as "unchanged"
  const directlyImportedIds = new Set<string>();
  for (const b of body.blocks) {
    if (b.block_id !== undefined) directlyImportedIds.add(b.block_id);
  }

  // Track source blocks that should be marked 'ignored' (used by virtual cards
  // but NOT also imported directly as unchanged)
  const toIgnore = new Set<string>();

  const batchStmts: Array<ReturnType<typeof c.env.DB.prepare>> = [];

  const questionIds: string[] = [];
  const mistakeIds: string[] = [];
  // Track per-block: which mistakeId pairs with which knowledge_ids/content for waitUntils
  const queueData: Array<{
    mistakeId: string;
    prompt_md: string;
    reference_md: string | null;
    wrong_answer_md: string;
    knowledge_ids: string[];
    cause: { primary_category: string; user_notes: string | null } | null;
  }> = [];

  for (const block of body.blocks) {
    let importedBlockId: string;

    if (block.block_id !== undefined) {
      importedBlockId = block.block_id;
    } else {
      // Virtual card (merged or split): INSERT new question_block
      importedBlockId = createId();
      const sourceRows = block.source_block_ids
        .map((sid) => sourceBlockRows.get(sid))
        .filter((r): r is QuestionBlockSelectRow => r !== undefined);
      // Preserve the highest complexity from any source — never downgrade.
      const visualComplexity = sourceRows.some((r) => r.visual_complexity === 'high')
        ? 'high'
        : sourceRows.some((r) => r.visual_complexity === 'medium')
          ? 'medium'
          : 'low';

      batchStmts.push(
        c.env.DB.prepare(
          `insert into question_block (
            id, ingestion_session_id, source_document_id, source_asset_ids,
            page_spans, extracted_prompt_md, reference_md, wrong_answer_md,
            image_refs, crop_refs, visual_complexity, extraction_confidence,
            status, knowledge_hint, merged_from_block_ids,
            imported_question_id, imported_mistake_id, created_at, updated_at, version
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).bind(
          importedBlockId,
          sessionId,
          session.source_document_id,
          JSON.stringify(block.image_refs),
          JSON.stringify(block.page_spans),
          block.final_prompt_md,
          block.final_reference_md,
          block.final_wrong_answer_md,
          JSON.stringify(block.image_refs),
          JSON.stringify([]),
          visualComplexity,
          1,
          'imported',
          null,
          JSON.stringify(block.source_block_ids),
          null, // imported_question_id (filled later by UPDATE)
          null, // imported_mistake_id  (filled later by UPDATE)
          now,
          now,
        ),
      );
      // Mark source blocks for 'ignored' status — except those being imported as unchanged
      for (const sid of block.source_block_ids) {
        if (!directlyImportedIds.has(sid)) {
          toIgnore.add(sid);
        }
      }
    }

    // Compute wrong_answer_image_refs
    const wrongAnswerImageRefs = [
      ...new Set(
        block.page_spans
          .filter((s) => s.role === 'answer_area')
          .map((s) => sessionAssetIds[s.page_index])
          .filter((id): id is string => typeof id === 'string' && block.image_refs.includes(id)),
      ),
    ];

    // INSERT question
    const questionId = createId();
    questionIds.push(questionId);
    const questionMetadata = JSON.stringify({
      prompt_image_refs: block.image_refs,
      prompt_image_ref_kind: 'source_asset_id',
      source_document_id: session.source_document_id,
      ingestion_session_id: sessionId,
      question_block_id: importedBlockId,
    });
    batchStmts.push(
      c.env.DB.prepare(
        `insert into question (
          id, kind, prompt_md, reference_md, knowledge_ids, difficulty,
          source, variant_depth, metadata, created_at, updated_at, version
        ) values (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)`,
      ).bind(
        questionId,
        block.question_kind,
        block.final_prompt_md,
        block.final_reference_md,
        JSON.stringify(block.knowledge_ids),
        block.difficulty,
        session.entrypoint,
        questionMetadata,
        now,
        now,
      ),
    );

    // INSERT mistake
    const mistakeId = createId();
    mistakeIds.push(mistakeId);
    const causeJson = block.cause
      ? JSON.stringify({
          primary_category: block.cause.primary_category,
          secondary_categories: [],
          ai_analysis_md: '',
          user_notes: block.cause.user_notes,
          user_edited: true,
        })
      : null;
    batchStmts.push(
      c.env.DB.prepare(
        `insert into mistake (
          id, question_id, wrong_answer_md, knowledge_ids, cause,
          wrong_answer_image_refs, source, variants, variants_generated_count, variants_max,
          status, created_at, updated_at, version
        ) values (?, ?, ?, ?, ?, ?, ?, '[]', 0, 3, 'active', ?, ?, 0)`,
      ).bind(
        mistakeId,
        questionId,
        block.final_wrong_answer_md,
        JSON.stringify(block.knowledge_ids),
        causeJson,
        JSON.stringify(wrongAnswerImageRefs),
        session.entrypoint,
        now,
        now,
      ),
    );

    // UPDATE question_block to set imported_question_id, imported_mistake_id, status
    batchStmts.push(
      c.env.DB.prepare(
        `update question_block set imported_question_id = ?, imported_mistake_id = ?, status = 'imported', updated_at = ?, version = version + 1 where id = ?`,
      ).bind(questionId, mistakeId, now, importedBlockId),
    );

    queueData.push({
      mistakeId,
      prompt_md: block.final_prompt_md,
      reference_md: block.final_reference_md,
      wrong_answer_md: block.final_wrong_answer_md,
      knowledge_ids: block.knowledge_ids,
      cause: block.cause,
    });
  }

  // UPDATE source blocks → status='ignored' (those not directly imported)
  for (const sid of toIgnore) {
    batchStmts.push(
      c.env.DB.prepare(
        `update question_block set status = ?, updated_at = ?, version = version + 1 where id = ?`,
      ).bind('ignored', now, sid),
    );
  }

  // UPDATE ingestion_session → status='imported'
  batchStmts.push(
    c.env.DB.prepare(
      `update ingestion_session set status = 'imported', updated_at = ?, version = version + 1 where id = ?`,
    ).bind(now, sessionId),
  );

  await c.env.DB.batch(batchStmts);

  // Queue post-write tasks
  for (const q of queueData) {
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await runProposeAndWrite({
            db: c.env.DB,
            mistakeContent: {
              prompt_md: q.prompt_md,
              reference_md: q.reference_md,
              wrong_answer_md: q.wrong_answer_md,
              knowledge_ids_picked: q.knowledge_ids,
            },
            runTaskFn: async (kind, input, ctx) => {
              const result = await runTask(kind, input, ctx as { env: typeof c.env });
              return { text: result.text };
            },
            env: c.env,
          });
        } catch (err) {
          console.error('propose prep failed (mistake unaffected)', err);
        }
      })(),
    );
    if (q.cause === null) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const tree = await loadTreeSnapshot(c.env.DB);
            const pickedNodes = tree.filter((n) => q.knowledge_ids.includes(n.id));
            await runAttributionAndWrite({
              db: c.env.DB,
              mistakeId: q.mistakeId,
              expectedVersion: 0,
              input: {
                prompt_md: q.prompt_md,
                reference_md: q.reference_md,
                wrong_answer_md: q.wrong_answer_md,
                knowledge_context: pickedNodes.map((n) => ({
                  id: n.id,
                  name: n.name,
                  effective_domain: n.effective_domain,
                })),
              },
              runTaskFn: async (kind, input, ctx) => {
                const result = await runTask(kind, input, ctx as { env: typeof c.env });
                return { text: result.text };
              },
              env: c.env,
            });
          } catch (err) {
            console.error('attribution prep failed (mistake unaffected)', err);
          }
        })(),
      );
    }
  }

  return c.json({ question_ids: questionIds, mistake_ids: mistakeIds });
});
