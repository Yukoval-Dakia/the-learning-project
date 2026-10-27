import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  type CopilotNudgeCompanionResponseSchema,
  CopilotRouteIdParamsSchema,
} from '../api/contracts';
import { NUDGE_ACTION, NUDGE_DISMISSED_ACTION, NUDGE_OPENED_ACTION } from './nudge-triggers';

/** postgres.js surfaces unique violations as code '23505' (possibly wrapped); walk the cause chain. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** 写一条 nudge companion event（dismiss / opened），先校验 nudge 存在防孤儿写。 */
async function writeNudgeCompanion(
  db: Db,
  params: Record<string, string>,
  action: typeof NUDGE_DISMISSED_ACTION | typeof NUDGE_OPENED_ACTION,
): Promise<z.infer<typeof CopilotNudgeCompanionResponseSchema>> {
  const { id: nudgeId } = CopilotRouteIdParamsSchema.parse(params);

  const exists = await db
    .select({ one: sql<number>`1` })
    .from(event)
    .where(and(eq(event.id, nudgeId), eq(event.action, NUDGE_ACTION)))
    .limit(1);
  if (exists.length === 0) {
    throw new ApiError('not_found', 'nudge not found', 404);
  }

  const companionId = newId();
  try {
    await writeEvent(db, {
      id: companionId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action,
      subject_kind: 'event',
      subject_id: nudgeId,
      outcome: null,
      payload: {},
      caused_by_event_id: nudgeId,
    });
  } catch (err) {
    // Idempotency: the per-action partial unique index on event(caused_by_event_id)
    // rejects a second companion for the same nudge (network retry / fast
    // double-click). Treat 23505 as already-recorded — return ok without a new
    // event so the opened/dismissed KPI is not double-counted. writeEvent's
    // onConflictDoNothing only targets the PK; other unique violations throw.
    if (isUniqueViolation(err)) {
      return { ok: true, deduped: true };
    }
    throw err;
  }
  return { ok: true, event_id: companionId };
}

export function dismissCopilotNudge(db: Db, params: Record<string, string>) {
  return writeNudgeCompanion(db, params, NUDGE_DISMISSED_ACTION);
}

export function markCopilotNudgeOpened(db: Db, params: Record<string, string>) {
  return writeNudgeCompanion(db, params, NUDGE_OPENED_ACTION);
}
