import { inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { Ingestion } from '@/server/session';
import { resolveSelectableSubjectId } from '@/subjects/profile';
import type { CreateIngestionSessionBody } from '../api/contracts';
import { type CreationResult, commitCreationReceipt } from './creation-receipts';
import { markSessionPackageFailed, materializeSourcePackage } from './source-package';

/** Complete creation owner shared by canonical and legacy HTTP consumers. */
export async function createIngestionSession(
  db: Db,
  body: z.infer<typeof CreateIngestionSessionBody>,
  key: string | null,
): Promise<CreationResult> {
  return commitCreationReceipt(
    db,
    'ingestion_session.create.v1',
    [body.entrypoint, body.asset_ids, body.subject_id ?? null, body.derivation_policy ?? null],
    key,
    async (tx) => {
      const requestedSubjectId = body.subject_id ?? null;
      const canonicalSubjectId =
        requestedSubjectId === null ? null : resolveSelectableSubjectId(requestedSubjectId);
      if (requestedSubjectId !== null && canonicalSubjectId === null) {
        throw new ApiError(
          'validation_error',
          `subject_id: unknown or not currently selectable subject '${requestedSubjectId}'`,
          400,
        );
      }
      const foundRows = await tx
        .select({ id: source_asset.id })
        .from(source_asset)
        .where(inArray(source_asset.id, body.asset_ids));
      const foundIds = new Set(foundRows.map((r) => r.id));
      const missing = body.asset_ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new ApiError('validation_error', `unknown asset_ids: ${missing.join(', ')}`, 400);
      }

      // initiateUpload's own transaction is a savepoint on this actual Tx.
      const { sessionId, sourceDocumentId } = await Ingestion.initiateUpload(tx, {
        assetIds: body.asset_ids,
        entrypoint: body.entrypoint,
        learnerSelectedSubjectId: canonicalSubjectId,
        derivationPolicy: body.derivation_policy ?? null,
      });
      const location = `/api/ingestion-sessions/${encodeURIComponent(sessionId)}`;
      try {
        // SQL errors must roll back this savepoint before marking failed in the
        // still-live outer transaction; a caught error alone cannot recover it.
        await tx.transaction((materializeTx) =>
          materializeSourcePackage(materializeTx, sourceDocumentId),
        );
      } catch (err) {
        const marked = await markSessionPackageFailed(tx, sessionId, err);
        if (marked !== 'marked_failed') {
          throw new Error(`new session source-package failure was not persisted: ${marked}`);
        }
        // Return a terminal error value. Throwing here would roll back the failed
        // session and its receipt; HTTP observes this only after the outer COMMIT.
        return {
          status: 500,
          body: {
            error: 'ingestion_source_package_failed',
            message: 'Source package materialization failed',
            details: { session_id: sessionId, source_document_id: sourceDocumentId },
          },
          location,
        };
      }
      return {
        status: 201,
        body: {
          session: {
            id: sessionId,
            source_document_id: sourceDocumentId,
            status: 'uploaded',
            source_asset_ids: body.asset_ids,
            entrypoint: body.entrypoint,
          },
        },
        location,
      };
    },
  );
}
