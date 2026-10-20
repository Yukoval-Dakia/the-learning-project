import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { getEvents } from '@/kernel/events';
import { ApiError, errorResponse } from '@/kernel/http';
import { resolveDocumentDerivationPolicy } from '@/kernel/read-models/usage-policy';

/**
 * YUK-1408 (S1 read side) — the subset of the usage-receipt payload the wire
 * exposes: WHICH categories fired and HOW MANY spans, never values. The
 * policy_version / channels stay inside the event for audit; the live
 * derivation_policy is resolved off the document separately (a consent
 * withdrawal after the receipt was written must show immediately). A
 * malformed payload throws — same fail-loud discipline as getEvents' strict
 * read-parse — rather than silently reporting an empty receipt.
 */
const UsageReceiptPayloadSchema = z.object({
  engine: z.string().optional(),
  channels: z
    .object({
      page_images: z.enum(['raw', 'none']),
      extracted_text: z.enum(['redacted', 'none']),
    })
    .optional(),
  redacted_fields: z.array(z.string()),
  redaction_counts: z.record(z.string(), z.number()),
});

async function readUsageReceipt(sourceDocumentId: string) {
  const [receipt] = await getEvents(db, {
    action: 'experimental:ingestion_usage_receipt',
    subject_kind: 'source_document',
    subject_id: sourceDocumentId,
    limit: 1,
  });
  if (!receipt) return null;
  // Recovery preserves an honest unknown receipt in the event stream. The
  // existing nullable read contract cannot present missing sink data as zero
  // redactions, nor parse that recovery evidence as a normal counted receipt.
  if (
    'redaction_accounting' in receipt.payload &&
    receipt.payload.redaction_accounting === 'unavailable'
  )
    return null;
  const payload = UsageReceiptPayloadSchema.parse(receipt.payload);
  return {
    derivation_policy: await resolveDocumentDerivationPolicy(db, sourceDocumentId),
    // 学习者需要被如实告知「原图是否原样交给了 AI」：拍照 / PDF 的识别引擎
    // 必须看原图才能识别（page_images:'raw'），只有识别出的文字会先脱敏。
    engine: payload.engine ?? null,
    channels: payload.channels ?? null,
    redacted_fields: payload.redacted_fields,
    redaction_counts: payload.redaction_counts,
    recorded_at: receipt.created_at.toISOString(),
  };
}

/** GET /api/ingestion-sessions/:id — readable target for creation Location headers. */
export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const [session] = await db
      .select({
        id: learning_session.id,
        status: learning_session.status,
        entrypoint: learning_session.entrypoint,
        source_document_id: learning_session.source_document_id,
        source_asset_ids: learning_session.source_asset_ids,
        warnings: learning_session.warnings,
        error_message: learning_session.error_message,
        created_at: learning_session.created_at,
        updated_at: learning_session.updated_at,
      })
      .from(learning_session)
      .where(and(eq(learning_session.id, params.id), eq(learning_session.type, 'ingestion')))
      .limit(1);

    if (!session) {
      throw new ApiError('not_found', 'ingestion session not found', 404);
    }

    return Response.json({
      session: {
        ...session,
        created_at: session.created_at.toISOString(),
        updated_at: session.updated_at.toISOString(),
      },
      usage_receipt: session.source_document_id
        ? await readUsageReceipt(session.source_document_id)
        : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
