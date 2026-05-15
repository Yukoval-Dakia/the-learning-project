import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { FigureRefT } from '@/core/schema/structured_question';
import { db } from '@/db/client';
import { question_block } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const Body = z.object({
  attached_to_index: z.string().min(1),
});

/**
 * PATCH /api/question-blocks/[id]/figures/[asset_id] —— 用户改 figure 归属。
 *
 * 验证 new attached_to_index 在 structured tree 内（递归 walk）。
 * 事务内：UPDATE figures[].attached_to_index + attach_confidence='manual' +
 * last_reassigned_at + bump version + writeJobEvent('figure.reassigned')。
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; asset_id: string }> },
): Promise<Response> {
  try {
    const { id: blockId, asset_id: assetId } = await params;
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', parsed.error.message, 400);
    }
    const { attached_to_index } = parsed.data;

    const result = await db.transaction(async (tx) => {
      const blocks = await tx.select().from(question_block).where(eq(question_block.id, blockId));
      const block = blocks[0];
      if (!block) {
        throw new ApiError('not_found', `question_block ${blockId} not found`, 404);
      }
      const figures = block.figures ?? [];
      const idx = figures.findIndex((f) => f.asset_id === assetId);
      if (idx < 0) {
        throw new ApiError('not_found', `figure ${assetId} not in block ${blockId}`, 404);
      }

      // Validate attached_to_index exists in structured tree
      const structured = block.structured;
      if (!structured || !idHasMatch(structured, attached_to_index)) {
        throw new ApiError(
          'validation_error',
          `attached_to_index '${attached_to_index}' not found in question_block.structured tree`,
          400,
        );
      }

      const nowIso = new Date().toISOString();
      const updatedFigures: FigureRefT[] = figures.map((f, i) =>
        i === idx
          ? {
              ...f,
              attached_to_index,
              attach_confidence: 'manual' as const,
              last_reassigned_at: new Date(nowIso),
            }
          : f,
      );

      await tx
        .update(question_block)
        .set({
          figures: updatedFigures,
          updated_at: new Date(),
          version: sql`${question_block.version} + 1`,
        })
        .where(eq(question_block.id, blockId));

      await writeJobEvent(tx, {
        business_table: 'question_block',
        business_id: blockId,
        event_type: 'figure.reassigned',
        payload: { asset_id: assetId, attached_to_index },
      });

      return { figures: updatedFigures };
    });

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

function idHasMatch(
  q: { id: string; sub_questions?: Array<{ id: string; sub_questions?: unknown[] }> },
  target: string,
): boolean {
  if (q.id === target) return true;
  for (const sub of q.sub_questions ?? []) {
    if (idHasMatch(sub as { id: string }, target)) return true;
  }
  return false;
}
