import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';

import { IngestionEntrypoint } from '@/core/schema/business';
import { db } from '@/db/client';
import { ingestion_session, question_block, source_asset, source_document } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import { ApiError, errorResponse } from '@/server/http/errors';
import { runOCRCascade } from '@/server/ingestion/cascade';
import { recognizeDocument } from '@/server/ingestion/ocr_tencent';
import { getR2 } from '@/server/r2';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

const Body = z.object({
  entrypoint: IngestionEntrypoint,
  asset_ids: z.array(z.string().min(1)).min(1).max(5),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const body = parsed.data;
    const r2 = getR2();

    // Validate all asset_ids exist in DB
    const assetRows: Array<{ id: string; storage_key: string; mime_type: string }> = [];
    const missingIds: string[] = [];
    for (const assetId of body.asset_ids) {
      const rows = await db
        .select({
          id: source_asset.id,
          storage_key: source_asset.storage_key,
          mime_type: source_asset.mime_type,
        })
        .from(source_asset)
        .where(eq(source_asset.id, assetId));
      if (rows.length === 0) {
        missingIds.push(assetId);
      } else {
        assetRows.push(rows[0]);
      }
    }
    if (missingIds.length > 0) {
      throw new ApiError('validation_error', `unknown asset_ids: ${missingIds.join(', ')}`, 400);
    }

    const now = new Date();
    const sourceDocId = createId();
    const sessionId = createId();

    await db.insert(source_document).values({
      id: sourceDocId,
      title: null,
      source_asset_ids: body.asset_ids,
      body_md: null,
      provenance: { entrypoint: body.entrypoint } as Record<string, unknown>,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await db.insert(ingestion_session).values({
      id: sessionId,
      source_document_id: sourceDocId,
      source_asset_ids: body.asset_ids,
      status: 'uploaded',
      entrypoint: body.entrypoint,
      error_message: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    type BlockRow = {
      block_id: string;
      source_block_ids: string[];
      page_spans: Array<{
        page_index: number;
        bbox: { x: number; y: number; width: number; height: number };
        role: string;
      }>;
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
      log: import('@/server/ingestion/cascade').TierLogEntry[];
    }> = [];

    for (let i = 0; i < assetRows.length; i++) {
      const row = assetRows[i];
      const pageIndex = i;

      const imageBytes = await r2.get(row.storage_key);
      if (!imageBytes) {
        console.error('ingestion: r2 object missing', {
          assetId: row.id,
          storageKey: row.storage_key,
        });
        failures.push({ asset_id: row.id, reason: 'r2_object_missing' });
        continue;
      }

      let extracted: {
        blocks: Array<{
          extracted_prompt_md: string;
          reference_md: string | null;
          wrong_answer_md: string | null;
          page_index: number;
          bbox: { x: number; y: number; width: number; height: number };
          role: 'prompt' | 'answer_area' | 'continuation';
          visual_complexity: 'low' | 'medium' | 'high';
          extraction_confidence: number;
          knowledge_hint: string | null;
        }>;
      };
      let tierLogForAsset: import('@/server/ingestion/cascade').TierLogEntry[] = [];

      try {
        const cascadeOut = await runOCRCascade({
          imageBytes: imageBytes.buffer as ArrayBuffer,
          mimeType: row.mime_type,
          pageIndex,
          deps: {
            recognizeDocument,
            runTaskFn: async (kind, input) => {
              const result = await runTask(kind, input, { db, r2 });
              return { text: result.text };
            },
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
        const blockNow = new Date();

        await db.insert(question_block).values({
          id: blockId,
          ingestion_session_id: sessionId,
          source_document_id: sourceDocId,
          source_asset_ids: [row.id],
          page_spans: pageSpans,
          extracted_prompt_md: block.extracted_prompt_md,
          reference_md: block.reference_md,
          wrong_answer_md: block.wrong_answer_md,
          image_refs: [row.id],
          crop_refs: [],
          visual_complexity: block.visual_complexity,
          extraction_confidence: block.extraction_confidence,
          status: 'draft',
          knowledge_hint: block.knowledge_hint,
          merged_from_block_ids: [],
          imported_question_id: null,
          imported_mistake_id: null,
          created_at: blockNow,
          updated_at: blockNow,
          version: 0,
        });

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

    const updatedAt = new Date();
    await db
      .update(ingestion_session)
      .set({ status: finalStatus, error_message: tierLogPayload, updated_at: updatedAt })
      .where(eq(ingestion_session.id, sessionId));

    return Response.json({
      session: {
        id: sessionId,
        source_document_id: sourceDocId,
        status: finalStatus,
        source_asset_ids: body.asset_ids,
        entrypoint: body.entrypoint,
        created_at: now.toISOString(),
        updated_at: updatedAt.toISOString(),
      },
      blocks,
      failures,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
