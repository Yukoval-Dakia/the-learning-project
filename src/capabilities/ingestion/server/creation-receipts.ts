import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { ingestion_creation_receipt } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  CreateMistakeResponseSchema,
  IngestionSessionCreationResponseSchema,
  IngestionSourcePackageFailedSchema,
} from '../api/contracts';

type CreationScope = typeof ingestion_creation_receipt.$inferInsert.operation_scope;
const ACTOR_REF = 'self';
const INPUT_VERSION = 1;
const UNAVAILABLE_MESSAGE =
  'Creation receipt unavailable; retry with the same key and original input';

const SessionTerminalSchema = z.union([
  z.strictObject({
    status: z.literal(201),
    body: IngestionSessionCreationResponseSchema,
    location: z.string(),
  }),
  z.strictObject({
    status: z.literal(500),
    body: IngestionSourcePackageFailedSchema,
    location: z.string(),
  }),
]);
const ManualTerminalSchema = z.strictObject({
  status: z.literal(201),
  body: CreateMistakeResponseSchema,
  location: z.string(),
});

export type CreationTerminal =
  | z.infer<typeof SessionTerminalSchema>
  | z.infer<typeof ManualTerminalSchema>;
export type CreationResult = CreationTerminal & { replayed: boolean };

function unavailable(): ApiError {
  return new ApiError('creation_receipt_unavailable', UNAVAILABLE_MESSAGE, 503);
}

function normalizeKey(raw: string | null): string | null {
  if (raw === null) return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > 200) {
    throw new ApiError('validation_error', 'Idempotency-Key must contain 1 to 200 characters', 400);
  }
  return key;
}

function checkedTerminal(scope: CreationScope, value: unknown): CreationTerminal {
  const parsed =
    scope === 'ingestion_session.create.v1'
      ? SessionTerminalSchema.safeParse(value)
      : ManualTerminalSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  const terminal = parsed.data;
  const body = terminal.body;
  const expectedLocation =
    'session' in body
      ? `/api/ingestion-sessions/${encodeURIComponent(body.session.id)}`
      : 'details' in body
        ? `/api/ingestion-sessions/${encodeURIComponent(body.details.session_id)}`
        : `/api/events/${encodeURIComponent(body.mistake_id)}`;
  if (terminal.location !== expectedLocation) throw unavailable();
  return terminal;
}

/**
 * Two creation operations only. The same actual transaction owns the key lock,
 * original creation, and INSERT-only terminal receipt. No-key callers retain
 * creation without a receipt. The returned result is observable only after COMMIT.
 */
export async function commitCreationReceipt(
  db: Db,
  scope: CreationScope,
  inputFields: readonly unknown[],
  rawKey: string | null,
  create: (tx: Tx) => Promise<CreationTerminal>,
): Promise<CreationResult> {
  const key = normalizeKey(rawKey);
  // Fixed field tuples come from the parsed-input owners. Do not sort arrays or
  // trim learner content. Hashing here is a business identity, not evidence sealing.
  const digest = createHash('sha256').update(JSON.stringify(inputFields)).digest('hex');
  try {
    return await db.transaction(async (tx) => {
      if (key !== null) {
        const identity = JSON.stringify([ACTOR_REF, scope, key]);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
        const [stored] = await tx
          .select()
          .from(ingestion_creation_receipt)
          .where(
            and(
              eq(ingestion_creation_receipt.actor_ref, ACTOR_REF),
              eq(ingestion_creation_receipt.operation_scope, scope),
              eq(ingestion_creation_receipt.idempotency_key, key),
            ),
          );
        if (stored) {
          // Unsupported or corrupt persisted truth is never a cache miss, even
          // when the new request's fingerprint differs.
          if (
            stored.input_version !== INPUT_VERSION ||
            !/^[0-9a-f]{64}$/.test(stored.input_digest) ||
            !(stored.created_at instanceof Date) ||
            !Number.isFinite(stored.created_at.getTime())
          ) {
            throw unavailable();
          }
          const terminal = checkedTerminal(scope, {
            status: stored.response_status,
            body: stored.response_body,
            location: stored.response_location,
          });
          if (stored.input_digest !== digest) {
            throw new ApiError(
              'idempotency_conflict',
              'Idempotency-Key was used with a different creation input',
              409,
            );
          }
          return { ...terminal, replayed: true };
        }
      }

      // Only a miss performs live subject/KC/cause/asset checks and mutations.
      const terminal = checkedTerminal(scope, await create(tx));
      if (key !== null) {
        await tx.insert(ingestion_creation_receipt).values({
          actor_ref: ACTOR_REF,
          operation_scope: scope,
          idempotency_key: key,
          input_version: INPUT_VERSION,
          input_digest: digest,
          response_status: terminal.status,
          response_body: terminal.body,
          response_location: terminal.location,
          created_at: new Date(),
        });
      }
      return { ...terminal, replayed: false };
    });
  } catch (err) {
    if (err instanceof ApiError || key === null) throw err;
    // Includes lock/receipt/connection/COMMIT failures. Never compensate with a
    // second connection or downgrade to non-idempotent creation after uncertainty.
    console.error('creation transaction unavailable', err);
    throw unavailable();
  }
}
