// Read-back of the write point's persisted crisis mark. Kept dependency-free
// (no attempt/submit edges) so recovery faces such as judge-run-observation can
// consume it without closing a module cycle into the write chain.
import { eq } from 'drizzle-orm';
import { CRISIS_GUARD_CONFIG_VERSION } from '@/core/crisis/classify';
import { type CrisisAttemptMark, CrisisAttemptMarkSchema } from '@/core/crisis/referral';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

/**
 * Single owner of mark parse semantics. Read faces that already hold the
 * attempt payload (paper detail, recovery projections) use this directly —
 * no re-classification, no extra round-trip.
 */
export function crisisMarkFromAttemptPayload(payload: unknown): CrisisAttemptMark | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.derivation_policy !== 'crisis') return null;
  const parsed = CrisisAttemptMarkSchema.safeParse({
    detection_class: record.crisis_detection_class,
    guard_version: record.crisis_guard_version,
  });
  return parsed.success
    ? parsed.data
    : { detection_class: 'explicit', guard_version: CRISIS_GUARD_CONFIG_VERSION };
}

/**
 * The mark the write point persisted on the attempt event, projected for the
 * submit response. Never re-classifies: a restricted event whose stored class
 * cannot be parsed still refers (fail toward support, same as the Copilot
 * 'none' fail-safe).
 */
export async function readAttemptCrisisMark(
  database: Db | Tx,
  attemptEventId: string,
): Promise<CrisisAttemptMark | null> {
  const [row] = await database
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, attemptEventId))
    .limit(1);
  return crisisMarkFromAttemptPayload(row?.payload);
}
