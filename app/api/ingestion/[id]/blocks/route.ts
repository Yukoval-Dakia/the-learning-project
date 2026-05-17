// Phase 1c.2 Vision MVP — GET /api/ingestion/[id]/blocks
//
// Returns question_block rows attached to an ingestion session so the /record
// vision flow can list extracted candidates for the user to review + import.
//
// Wire shape (one row per block):
//   {
//     id,
//     ingestion_session_id,
//     source_asset_ids: string[],
//     page_spans: Array<{ page_index, bbox: {x,y,width,height}, role? }>,
//     extracted_prompt_md: string | null,
//     reference_md: string | null,
//     wrong_answer_md: string | null,
//     image_refs: string[],
//     layout_quality: 'structured' | 'partial' | 'text_only',
//     extraction_confidence: number,
//     status: 'draft' | 'imported' | 'ignored',
//     knowledge_hint: string | null,
//     created_at: number, // unix sec
//   }

import { asc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { question_block } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await params;
    const rows = await db
      .select({
        id: question_block.id,
        ingestion_session_id: question_block.ingestion_session_id,
        source_asset_ids: question_block.source_asset_ids,
        page_spans: question_block.page_spans,
        extracted_prompt_md: question_block.extracted_prompt_md,
        structured: question_block.structured,
        reference_md: question_block.reference_md,
        wrong_answer_md: question_block.wrong_answer_md,
        image_refs: question_block.image_refs,
        layout_quality: question_block.layout_quality,
        extraction_confidence: question_block.extraction_confidence,
        status: question_block.status,
        knowledge_hint: question_block.knowledge_hint,
        created_at: question_block.created_at,
      })
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId))
      .orderBy(asc(question_block.created_at));

    return Response.json({
      rows: rows.map((r) => ({
        ...r,
        created_at: Math.floor(r.created_at.getTime() / 1000),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
