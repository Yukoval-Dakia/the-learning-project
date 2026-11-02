import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { type Tx, db } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { resolveDocumentDerivationPolicy } from '@/kernel/read-models/usage-policy';

const UsageReceiptMetadataSchema = z.object({
  engine: z.string().optional(),
  channels: z
    .object({
      page_images: z.enum(['raw', 'none']),
      extracted_text: z.enum(['redacted', 'none']),
    })
    .optional(),
});

const UsageReceiptPayloadSchema = z.union([
  UsageReceiptMetadataSchema.extend({
    redaction_accounting: z.undefined(),
    redacted_fields: z.array(z.string()),
    redaction_counts: z.record(
      z.string(),
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ),
  }),
  UsageReceiptMetadataSchema.extend({
    redaction_accounting: z.literal('unavailable'),
    redacted_fields: z.null(),
    redaction_counts: z.null(),
  }),
]);

/** Fold persisted uses, including repeated source spans across segments and runs. */
async function readUsageReceipt(tx: Tx, sessionId: string, sourceDocumentId: string) {
  // One table, no join and no limit: the event PK makes every persisted receipt
  // occur exactly once. Segment numbers are not unique across runs.
  const receipts = await tx
    .select({ id: event.id, payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.action, 'experimental:ingestion_usage_receipt'),
        eq(event.subject_kind, 'source_document'),
        eq(event.subject_id, sourceDocumentId),
        eq(event.actor_kind, 'system'),
        eq(event.actor_ref, 'ingestion_privacy_guard'),
        eq(event.outcome, 'success'),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id));
  if (receipts.length === 0) return null;

  const fields = new Set<string>();
  const counts = new Map<string, number>();
  const engines = new Set<string | null>();
  let accountingUnavailable = false;
  let channelsUnknown = false;
  let pageImagesRaw = false;
  let extractedTextRedacted = false;
  let recordedAt = '';
  for (const receipt of receipts) {
    const parsed = UsageReceiptPayloadSchema.safeParse(receipt.payload);
    // Do not include payload values or Zod diagnostics in the error or logs.
    if (!parsed.success) throw new Error('Invalid ingestion usage receipt payload');
    const payload = parsed.data;
    engines.add(payload.engine ?? null);
    if (payload.channels === undefined) channelsUnknown = true;
    else {
      pageImagesRaw ||= payload.channels.page_images === 'raw';
      extractedTextRedacted ||= payload.channels.extracted_text === 'redacted';
    }
    recordedAt = receipt.created_at.toISOString();
    if (payload.redaction_accounting === 'unavailable') {
      accountingUnavailable = true;
      continue;
    }
    for (const field of payload.redacted_fields) fields.add(field);
    for (const [field, count] of Object.entries(payload.redaction_counts)) {
      const total = (counts.get(field) ?? 0) + count;
      if (!Number.isSafeInteger(total)) throw new Error('Ingestion usage receipt count overflow');
      counts.set(field, total);
    }
  }
  // Still validate every receipt above: a later counted use cannot repair an old
  // missing sink, and missing accounting must never become a partial total or 0.
  if (accountingUnavailable) return null;

  return {
    derivation_policy: await resolveDocumentDerivationPolicy(tx, sourceDocumentId),
    engine: engines.size === 1 ? [...engines][0] : null,
    channels: channelsUnknown
      ? null
      : {
          page_images: pageImagesRaw ? ('raw' as const) : ('none' as const),
          extracted_text: extractedTextRedacted ? ('redacted' as const) : ('none' as const),
        },
    redacted_fields: [...fields].sort(),
    redaction_counts: Object.fromEntries(counts),
    recorded_at: recordedAt,
  };
}

/** Own the session, its complete persisted usage and live policy in one snapshot. */
export async function readIngestionSessionDetail(sessionId: string) {
  return db.transaction(
    async (tx) => {
      const [session] = await tx
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
        .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')))
        .limit(1);
      if (!session) throw new ApiError('not_found', 'ingestion session not found', 404);

      return {
        session: {
          ...session,
          created_at: session.created_at.toISOString(),
          updated_at: session.updated_at.toISOString(),
        },
        usage_receipt: session.source_document_id
          ? await readUsageReceipt(tx, session.id, session.source_document_id)
          : null,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
