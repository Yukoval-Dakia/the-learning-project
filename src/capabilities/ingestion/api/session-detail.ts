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
  const payload = UsageReceiptPayloadSchema.parse(receipt.payload);
  return {
    derivation_policy: await resolveDocumentDerivationPolicy(db, sourceDocumentId),
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
