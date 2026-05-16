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

import type { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event, mistake } from '@/db/schema';
import { deterministicId } from '@/core/ids';
import { parseEvent } from '@/core/schema/event';
import type { Cause } from '@/core/schema/business';

type DbLike = Db | Tx;
type LegacyCause = z.infer<typeof Cause>;

/**
 * Bridge legacy `mistake.cause` (business.ts Cause) → Lane B `CauseSchema`.
 *
 * 3 differences vs Lane B:
 *   1. `ai_analysis_md` → `analysis_md` (rename)
 *   2. `confidence` legacy nullable → Lane B required (default 0.5 when null)
 *   3. `user_notes / partial / user_edited` are legacy-only — dropped.
 *      Forensic data preserved in legacy `mistake` table (Step 9 drops it).
 */
function bridgeCause(legacy: LegacyCause) {
  return {
    primary_category: legacy.primary_category,
    secondary_categories: legacy.secondary_categories ?? [],
    analysis_md: legacy.ai_analysis_md,
    confidence: legacy.confidence ?? 0.5,
  };
}

/**
 * 3.A + 3.B — Migrate `mistake` rows into `event(action='attempt')` and,
 * when `mistake.cause` is non-null, a chained `event(action='judge')`.
 *
 * Each mistake → 1 attempt event (always); + 1 judge event if cause exists.
 * Judge `caused_by_event_id` chains to the attempt's deterministic ID.
 *
 * Idempotent: deterministic event IDs +
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

    // 3.B — chained judge event if legacy cause exists. Lane B JudgeOnEvent:
    // actor=agent / action='judge' / subject='event' / outcome='success'
    // payload = { cause: CauseSchema, referenced_knowledge_ids }
    if (m.cause !== null) {
      const judgeEvent = {
        id: deterministicId('evt_judge', m.id),
        session_id: null,
        actor_kind: 'agent' as const,
        actor_ref: 'legacy_attribution', // marker — pre-v2 attribution lost task_run linkage
        action: 'judge' as const,
        subject_kind: 'event' as const,
        subject_id: attemptId,
        outcome: 'success' as const,
        payload: {
          cause: bridgeCause(m.cause),
          referenced_knowledge_ids: m.knowledge_ids ?? [],
        },
        caused_by_event_id: attemptId,
        task_run_id: null,
        cost_micro_usd: null,
        // best proxy — original attribution timestamp lost; updated_at marks last write
        created_at: m.updated_at,
      };

      parseEvent({
        actor_kind: judgeEvent.actor_kind,
        actor_ref: judgeEvent.actor_ref,
        action: judgeEvent.action,
        subject_kind: judgeEvent.subject_kind,
        subject_id: judgeEvent.subject_id,
        outcome: judgeEvent.outcome,
        payload: judgeEvent.payload,
      });

      await db.insert(event).values(judgeEvent).onConflictDoNothing({ target: event.id });
    }
  }
}
