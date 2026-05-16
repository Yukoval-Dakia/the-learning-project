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

import { deterministicId } from '@/core/ids';
import type { Cause } from '@/core/schema/business';
import { parseEvent } from '@/core/schema/event';
import type { Db, Tx } from '@/db/client';
import {
  dreaming_proposal,
  event,
  ingestion_session,
  learning_session,
  material_fsrs_state,
  mistake,
  review_event,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';

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

/**
 * 3.C — Migrate `review_event` rows into `event(action='review')` and project
 * the latest per-question state into `material_fsrs_state`.
 *
 * Algorithm:
 *   1. JOIN review_event ↔ mistake to recover question_id + knowledge_ids
 *      (review_event.mistake_id, not question_id directly).
 *   2. Emit one `event(action='review')` per review_event with deterministic
 *      ID `evt_review_<review_event.id>`.
 *   3. Group by question_id, take MAX(created_at) review → write
 *      `material_fsrs_state` keyed at question grain.
 *   4. Fallback: for mistakes with `fsrs_state IS NOT NULL` but ZERO
 *      review_events, project `mistake.fsrs_state` directly with
 *      `last_review_event_id: null`.
 *
 * Note: Lane B `ReviewOnQuestion` intentionally drops
 * `fsrs_state_before / due_at_before / due_at_next / latency_ms` — they live in
 * the legacy `review_event` table for forensics (Step 9 drops it).
 */
export async function migrateReviewEvents(db: DbLike): Promise<void> {
  // JOIN review_event ↔ mistake to recover question_id + knowledge_ids.
  // Drizzle query API doesn't expose a typed select with JOIN cleanly across
  // mixed jsonb types; raw .innerJoin in select chain is the canonical pattern.
  const reviews = await db
    .select({
      review: review_event,
      question_id: mistake.question_id,
      knowledge_ids: mistake.knowledge_ids,
    })
    .from(review_event)
    .innerJoin(mistake, eq(review_event.mistake_id, mistake.id));

  // (1) + (2): emit one review event per row.
  for (const row of reviews) {
    const r = row.review;
    const evtId = deterministicId('evt_review', r.id);
    // outcome invariant: again→failure, hard/good→success
    const outcome = r.rating === 'again' ? ('failure' as const) : ('success' as const);
    const reviewEvent = {
      id: evtId,
      session_id: null,
      actor_kind: 'user' as const,
      actor_ref: 'self',
      action: 'review' as const,
      subject_kind: 'question' as const,
      subject_id: row.question_id,
      outcome,
      payload: {
        fsrs_rating: r.rating as 'again' | 'hard' | 'good',
        fsrs_state_after: r.fsrs_state_after,
        user_response_md: r.response_md ?? null,
        referenced_knowledge_ids: row.knowledge_ids ?? [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: r.created_at,
    };

    parseEvent({
      actor_kind: reviewEvent.actor_kind,
      actor_ref: reviewEvent.actor_ref,
      action: reviewEvent.action,
      subject_kind: reviewEvent.subject_kind,
      subject_id: reviewEvent.subject_id,
      outcome: reviewEvent.outcome,
      payload: reviewEvent.payload,
    });

    await db.insert(event).values(reviewEvent).onConflictDoNothing({ target: event.id });
  }

  // (3): group by question_id, project the latest review into material_fsrs_state.
  // Build the projection in JS (clearer than SQL window functions for fixture sizes):
  const latestByQuestion = new Map<
    string,
    { review: typeof review_event.$inferSelect; question_id: string }
  >();
  for (const row of reviews) {
    const prev = latestByQuestion.get(row.question_id);
    if (!prev || row.review.created_at > prev.review.created_at) {
      latestByQuestion.set(row.question_id, { review: row.review, question_id: row.question_id });
    }
  }

  for (const { review: latest, question_id } of latestByQuestion.values()) {
    const fsrsRow = {
      id: deterministicId('fsrs', question_id),
      subject_kind: 'question',
      subject_id: question_id,
      state: latest.fsrs_state_after,
      due_at: latest.due_at_next,
      last_review_event_id: deterministicId('evt_review', latest.id),
      updated_at: latest.created_at,
    };
    await db
      .insert(material_fsrs_state)
      .values(fsrsRow)
      .onConflictDoNothing({ target: material_fsrs_state.id });
  }

  // (4): fallback — mistakes with fsrs_state but ZERO review_events.
  // Pick mistakes with non-null fsrs_state, NOT referenced by any review_event.
  // Use the drizzle typed select so timestamps come back as Date (raw `execute`
  // returns ISO strings under postgres-js, which then fail drizzle's Date
  // serializer on the subsequent insert).
  const allMistakesWithFsrs = await db.select().from(mistake);
  const reviewedMistakeIds = new Set(
    (await db.select({ mistake_id: review_event.mistake_id }).from(review_event)).map(
      (r) => r.mistake_id,
    ),
  );
  const fallbackMistakes = allMistakesWithFsrs.filter(
    (m) => m.fsrs_state !== null && !reviewedMistakeIds.has(m.id),
  );

  for (const m of fallbackMistakes) {
    // mistake.fsrs_state is $type<FsrsStateT>; due is a Date | ISO string after
    // jsonb roundtrip — coerce to Date for the timestamp column.
    const state = m.fsrs_state as { due: string | Date };
    const dueValue = state.due instanceof Date ? state.due : new Date(state.due);
    const fsrsRow = {
      id: deterministicId('fsrs', m.question_id),
      subject_kind: 'question',
      subject_id: m.question_id,
      state: m.fsrs_state as typeof material_fsrs_state.$inferInsert.state,
      due_at: dueValue,
      last_review_event_id: null,
      updated_at: m.created_at,
    };
    await db
      .insert(material_fsrs_state)
      .values(fsrsRow)
      .onConflictDoNothing({ target: material_fsrs_state.id });
  }
}

/**
 * 3.D — Migrate `dreaming_proposal` rows into `event(action='propose',
 * subject_kind='knowledge')` per Lane B `ProposeKnowledge` shape.
 *
 * Defensive payload extraction — legacy `dreaming_proposal.payload` is loose
 * jsonb; in practice should carry `{ proposed_knowledge: { name, parent_id, ...
 * }, ... }` per parent plan §"读 dreaming_proposal", but legacy AI output may
 * vary. We accept both `payload.proposed_knowledge.{name,parent_id}` and
 * top-level fallbacks; if neither yields name + parent_id, skip with a stable
 * warn marker (the contract is strict; we don't fabricate data).
 *
 * outcome mapping (Lane B ProposeKnowledge.outcome ∈ {'success', 'partial'}):
 *   accepted → success
 *   pending  → partial
 *   rejected → partial + reasoning prefix '[legacy rejected] '
 *     (Lane B drops 'failure' from propose outcome on purpose — rejected
 *     proposals are early-stage experiments; forensic data preserved in
 *     legacy dreaming_proposal table.)
 */
export async function migrateDreamingProposals(db: DbLike): Promise<void> {
  const rows = await db.select().from(dreaming_proposal);
  for (const p of rows) {
    const payload = (p.payload ?? {}) as Record<string, unknown>;
    const proposed = (payload.proposed_knowledge ?? {}) as Record<string, unknown>;
    const name =
      (proposed.name as string | undefined) ?? (payload.name as string | undefined) ?? null;
    const parentId =
      (proposed.parent_id as string | undefined) ??
      (payload.parent_id as string | undefined) ??
      null;
    const subjectId = (proposed.id as string | undefined) ?? deterministicId('k_legacy', p.id);

    if (name === null || parentId === null) {
      // Strict KnownEvent contract — don't construct invalid event. Stable
      // warn prefix lets tests/observers grep for these.
      console.warn(
        `[migrate-phase1c1] skip propose id=${p.id} kind=${p.kind}: missing name or parent_id in payload`,
      );
      continue;
    }

    const outcome = p.status === 'accepted' ? ('success' as const) : ('partial' as const);
    // Forensic prefix for rejected → otherwise the rejection signal disappears
    // (Lane B doesn't allow outcome='failure' on propose).
    const reasoning =
      p.status === 'rejected'
        ? `[legacy rejected] ${p.reasoning ?? '(legacy: reasoning missing)'}`
        : (p.reasoning ?? '(legacy: reasoning missing)');

    const proposeEvent = {
      id: deterministicId('evt_propose', p.id),
      session_id: null,
      actor_kind: 'agent' as const,
      actor_ref: 'dreaming',
      action: 'propose' as const,
      subject_kind: 'knowledge' as const,
      subject_id: subjectId,
      outcome,
      payload: {
        name,
        parent_id: parentId,
        reasoning,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: p.proposed_at,
    };

    parseEvent({
      actor_kind: proposeEvent.actor_kind,
      actor_ref: proposeEvent.actor_ref,
      action: proposeEvent.action,
      subject_kind: proposeEvent.subject_kind,
      subject_id: proposeEvent.subject_id,
      outcome: proposeEvent.outcome,
      payload: proposeEvent.payload,
    });

    await db.insert(event).values(proposeEvent).onConflictDoNothing({ target: event.id });
  }
}

/**
 * 3.F — Precheck: assert the legacy `judgment` table is empty (or absent).
 *
 * Per data-assumptions §O2 (and Lane A's Step 1.4 DROP), no rows should have
 * ever been written to `judgment`; we DROPped it. This precheck is defensive
 * for environments where the migration runs on older snapshots (e.g., a NAS
 * backup taken before Step 1.4). Behaviour:
 *
 *   - table absent → ok (production / post-Step-1.4 state)
 *   - table present but COUNT = 0 → ok
 *   - table present with rows → ok=false; caller (orchestrator) refuses to run
 *
 * Stable error marker `judgment table` lets observers grep for these.
 */
export async function assertJudgmentEmpty(
  db: DbLike,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // to_regclass returns NULL when the relation doesn't exist (no error thrown).
  const existsRows = await db.execute<{ exists: boolean }>(
    sql`SELECT to_regclass('public.judgment') IS NOT NULL AS exists`,
  );
  const exists = existsRows[0]?.exists ?? false;
  if (!exists) return { ok: true };

  const countRows = await db.execute<{ count: string | number }>(
    sql`SELECT COUNT(*)::bigint AS count FROM "judgment"`,
  );
  const raw = countRows[0]?.count ?? 0;
  // postgres-js may return bigint counts as strings; coerce defensively.
  const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
  if (count === 0) return { ok: true };

  return {
    ok: false,
    error: `judgment table is not empty: ${count} row${count === 1 ? '' : 's'} present (data-assumptions §O2 violation; manual triage required)`,
  };
}

/**
 * 3.E — Migrate `ingestion_session` rows into `learning_session(type='ingestion')`.
 *
 * Preserves the legacy id verbatim — some downstream code may reference these
 * session IDs and the ADR-0008 polymorphic envelope explicitly accepts this.
 *
 * `ended_at`: set to `updated_at` when status is terminal
 * ('imported' | 'failed'); null otherwise (mid-flight sessions).
 *
 * `summary_md` / `goal_id`: ingestion sessions had no summaries or goal
 * linkage, so both are null.
 */
export async function migrateIngestionSessions(db: DbLike): Promise<void> {
  const rows = await db.select().from(ingestion_session);
  for (const s of rows) {
    const isTerminal = s.status === 'imported' || s.status === 'failed';
    await db
      .insert(learning_session)
      .values({
        id: s.id, // preserve legacy id for FK reference continuity
        type: 'ingestion',
        status: s.status, // ingestion status enum already aligned with Lane B IngestionStatus
        source_document_id: s.source_document_id,
        source_asset_ids: s.source_asset_ids,
        entrypoint: s.entrypoint,
        warnings: s.warnings,
        error_message: s.error_message,
        summary_md: null,
        goal_id: null,
        started_at: s.created_at,
        ended_at: isTerminal ? s.updated_at : null,
        version: s.version,
        created_at: s.created_at,
        updated_at: s.updated_at,
      })
      .onConflictDoNothing({ target: learning_session.id });
  }
}

/**
 * 3.G — Top-level orchestrator. Runs all migrate fns in additive order, gated
 * on the §O2 judgment-empty precheck.
 *
 * Idempotency note: each migrate fn uses deterministic IDs (`deterministicId`)
 * + `onConflictDoNothing` on PK. Re-running is a no-op via the PK conflict
 * mechanism alone — no separate "already migrated?" SELECT is needed. This
 * is robust against partial migrations (e.g., crash mid-flight): retrying
 * picks up where it left off without double-writing.
 *
 * Order is somewhat arbitrary (no inter-fn dependencies thanks to additive +
 * idempotent design), but we run review_events AFTER mistakes since the
 * fallback path in migrateReviewEvents reads mistakes to project FSRS state.
 */
export async function runMigration(
  db: DbLike,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const precheck = await assertJudgmentEmpty(db);
  if (!precheck.ok) {
    // Refuse to proceed — data-assumptions violation. Log + return error;
    // caller (Step 8 CLI / cron) can exit non-zero on this result.
    console.warn(`[migrate-phase1c1] aborting: ${precheck.error}`);
    return precheck;
  }

  await migrateMistakes(db);
  await migrateReviewEvents(db);
  await migrateDreamingProposals(db);
  await migrateIngestionSessions(db);

  return { ok: true };
}
