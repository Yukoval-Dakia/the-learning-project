// Phase 1c.1 Step 3 — legacy → event-driven migration.
//
// Maps 4 legacy tables to the new event-driven shape per
// docs/superpowers/plans/2026-05-16-phase1c1-step3-migration.md and Lane B's
// locked KnownEvent contract in src/core/schema/event/known.ts.
//
// Properties (locked by spec):
//   - Additive: never UPDATE/DELETE legacy tables; Step 9 drops them.
//   - Idempotent: deterministic event IDs (`deterministicId(prefix, sourceId)`)
//     + INSERT ... ON CONFLICT DO NOTHING make re-running a no-op.
//   - Parse-guarded: every constructed event passes `parseEvent` BEFORE INSERT
//     so any drift from Lane B's KnownEvent shape fails loudly here.
//   - Drizzle ORM for all writes (consistency with rest of codebase).

import type { Db, Tx } from '@/db/client';
import { event, mistake } from '@/db/schema';
import { deterministicId } from '@/core/ids';
import { parseEvent } from '@/core/schema/event';

type DbLike = Db | Tx;

/**
 * 3.A — Migrate `mistake` rows into `event(action='attempt')`.
 *
 * Each mistake → 1 attempt event (always). If `mistake.cause` is non-null,
 * also emit a chained judge event (covered in 3.B).
 *
 * Idempotent: deterministic event ID `evt_mistake_<mistake.id>` +
 * onConflictDoNothing on PK means re-running is a no-op.
 */
export async function migrateMistakes(db: DbLike): Promise<void> {
  const rows = await db.select().from(mistake);
  for (const m of rows) {
    const attemptId = deterministicId('evt_mistake', m.id);
    // Lane B AttemptOnQuestion.payload: { answer_md, answer_image_refs, duration_ms?, referenced_knowledge_ids }
    const attemptEvent = {
      id: attemptId,
      session_id: null,
      actor_kind: 'user' as const,
      actor_ref: 'self',
      action: 'attempt' as const,
      subject_kind: 'question' as const,
      subject_id: m.question_id,
      outcome: 'failure' as const,
      payload: {
        answer_md: m.wrong_answer_md ?? null,
        answer_image_refs: m.wrong_answer_image_refs ?? [],
        // feeds knowledge_mastery view (ADR-0012)
        referenced_knowledge_ids: m.knowledge_ids ?? [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: m.created_at,
    };

    // Parse-guard before INSERT — drift fails loudly.
    parseEvent({
      actor_kind: attemptEvent.actor_kind,
      actor_ref: attemptEvent.actor_ref,
      action: attemptEvent.action,
      subject_kind: attemptEvent.subject_kind,
      subject_id: attemptEvent.subject_id,
      outcome: attemptEvent.outcome,
      payload: attemptEvent.payload,
    });

    await db.insert(event).values(attemptEvent).onConflictDoNothing({ target: event.id });
  }
}
