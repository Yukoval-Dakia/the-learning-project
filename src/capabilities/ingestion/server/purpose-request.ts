import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { PurposeChangeInput } from '@/kernel/read-models/purpose-change';
import {
  PurposeChangeResponse,
  PurposeImpactQuery,
  PurposeImpactResponse,
} from '../api/purpose-contracts';
import { changeIngestionPurpose, readIngestionPurposeImpact } from './purpose-change';

/** Own the complete purpose-change request and its receipt response policy. */
export async function requestPurposeChange(
  db: Db,
  params: Record<string, string>,
  readBody: () => Promise<unknown>,
) {
  const parsed = PurposeChangeInput.safeParse(await readBody().catch(() => null));
  if (!parsed.success) throw new ApiError('validation_error', 'invalid purpose command', 400);
  const result = await changeIngestionPurpose(db, params.id, parsed.data);
  const headers: Record<string, string> = {
    Location: `/api/ingestion-sessions/${encodeURIComponent(params.id)}/purpose?request_id=${parsed.data.request_id}`,
    ...(result.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
  };
  return { body: PurposeChangeResponse.parse(result), headers };
}

/** Own the complete purpose-impact read: query validation, session binding and response shape. */
export async function requestPurposeImpact(
  db: Db,
  params: Record<string, string>,
  rawQuery: Record<string, string>,
) {
  const query = PurposeImpactQuery.safeParse(rawQuery);
  if (!query.success) throw new ApiError('validation_error', 'invalid purpose impact query', 400);
  return PurposeImpactResponse.parse(
    await readIngestionPurposeImpact(db, params.id, query.data.request_id),
  );
}
