import { Hono } from 'hono';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { runTask } from '../ai/runner';
import { runVisionExtract } from '../ingestion/vision';
import { IngestionEntrypoint } from '../../../src/core/schema/business';
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
  let successCount = 0;

  for (let i = 0; i < assetRows.length; i++) {
    const row = assetRows[i];
    const pageIndex = i;

    const r2Object = await c.env.IMAGES.get(row.storage_key);
    if (!r2Object) {
      continue;
    }

    const imageBytes = await r2Object.arrayBuffer();

    let extracted: Awaited<ReturnType<typeof runVisionExtract>>;
    try {
      extracted = await runVisionExtract({
        assetId: row.id,
        mimeType: row.mime_type,
        imageBytes,
        pageIndex,
        runTaskFn,
        env: c.env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void msg;
      continue;
    }

    successCount++;

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

  const finalStatus =
    successCount === 0 ? 'failed' : 'extracted';

  const updatedAt = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `update ingestion_session set status = ?, updated_at = ?, version = version + 1 where id = ?`,
  )
    .bind(finalStatus, updatedAt, sessionId)
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
