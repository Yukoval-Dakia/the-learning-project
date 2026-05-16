// Phase 1c.1 Step 4 — events queries module (ADR-0005 single-owner read/write API).
//
// Per spec §"New module: src/server/events/queries.ts" (docs/superpowers/plans/
// 2026-05-16-phase1c1-step4-server-readpath.md): all event reads/writes go through
// this module. Other modules import named fns; raw `db.insert(event)` outside this
// module is forbidden.
//
// Read API:
//   - getFailureAttempts(db, opts?) — failure attempts + chained judge (mistake view)
//   - getJudgeForAttempt(db, attemptEventId) — single chained judge
//   - getRecentReviewEvents(db, opts?) — FSRS review log
//   - getEventById(db, id) — single event for caused_by chain navigation
//
// Write API:
//   - writeEvent(db, eventObj) — single INSERT path; calls parseEvent() before INSERT;
//     idempotent via PK conflict do-nothing.

import { parseEvent } from '@/core/schema/event';
import type { CauseSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

// ============================================================================
// FailureAttempt — user-facing "mistake" view projected from the event stream.
// One row per attempt event with outcome='failure'; optional joined judge event
// chained via caused_by_event_id reverse lookup.
// ============================================================================

export type FailureAttemptJudge = {
  judge_event_id: string;
  cause: CauseSchemaT;
  referenced_knowledge_ids: string[];
  created_at: Date;
};

export type FailureAttempt = {
  attempt_event_id: string;
  question_id: string;
  answer_md: string | null;
  answer_image_refs: string[];
  referenced_knowledge_ids: string[];
  created_at: Date;
  judge?: FailureAttemptJudge;
};

export interface GetFailureAttemptsOpts {
  limit?: number;
  questionIds?: string[];
  since?: Date;
}

const DEFAULT_FAILURE_ATTEMPTS_LIMIT = 100;

/**
 * Returns failure attempts (with chained judges populated when present), ordered
 * by created_at desc. Default limit 100 matches legacy RECENT_MISTAKES_LIMIT.
 *
 * Two queries + JS join (vs single subquery): clearer code, well-bounded by limit.
 * Judge lookup uses `event_caused_by_idx`. Filter must keep outcome='failure' —
 * the event stream stores successes too.
 */
export async function getFailureAttempts(
  db: DbLike,
  opts: GetFailureAttemptsOpts = {},
): Promise<FailureAttempt[]> {
  const limit = opts.limit ?? DEFAULT_FAILURE_ATTEMPTS_LIMIT;
  const conditions = [
    eq(event.action, 'attempt'),
    eq(event.subject_kind, 'question'),
    eq(event.outcome, 'failure'),
  ];
  if (opts.questionIds && opts.questionIds.length > 0) {
    conditions.push(inArray(event.subject_id, opts.questionIds));
  }
  if (opts.since) {
    conditions.push(gte(event.created_at, opts.since));
  }
  const attemptRows = await db
    .select()
    .from(event)
    .where(and(...conditions))
    .orderBy(desc(event.created_at))
    .limit(limit);

  if (attemptRows.length === 0) return [];

  const attemptIds = attemptRows.map((r) => r.id);
  const judgeRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        inArray(event.caused_by_event_id, attemptIds),
      ),
    );

  // Group judges by caused_by_event_id (one judge per attempt expected; keep newest if dupes).
  const judgeByAttempt = new Map<string, (typeof judgeRows)[number]>();
  for (const j of judgeRows) {
    const key = j.caused_by_event_id as string;
    const existing = judgeByAttempt.get(key);
    if (!existing || j.created_at > existing.created_at) {
      judgeByAttempt.set(key, j);
    }
  }

  return attemptRows.map((a) => {
    const payload = a.payload as {
      answer_md: string | null;
      answer_image_refs: string[];
      referenced_knowledge_ids: string[];
    };
    const result: FailureAttempt = {
      attempt_event_id: a.id,
      question_id: a.subject_id,
      answer_md: payload.answer_md ?? null,
      answer_image_refs: payload.answer_image_refs ?? [],
      referenced_knowledge_ids: payload.referenced_knowledge_ids ?? [],
      created_at: a.created_at,
    };
    const j = judgeByAttempt.get(a.id);
    if (j) {
      const jPayload = j.payload as {
        cause: CauseSchemaT;
        referenced_knowledge_ids: string[];
      };
      result.judge = {
        judge_event_id: j.id,
        cause: jPayload.cause,
        referenced_knowledge_ids: jPayload.referenced_knowledge_ids ?? [],
        created_at: j.created_at,
      };
    }
    return result;
  });
}

/**
 * Returns the (latest) judge event chained to the given attempt, or null.
 * Uses `event_caused_by_idx`.
 */
export async function getJudgeForAttempt(
  db: DbLike,
  attemptEventId: string,
): Promise<FailureAttemptJudge | null> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        eq(event.caused_by_event_id, attemptEventId),
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  const j = rows[0];
  if (!j) return null;
  const jPayload = j.payload as {
    cause: CauseSchemaT;
    referenced_knowledge_ids: string[];
  };
  return {
    judge_event_id: j.id,
    cause: jPayload.cause,
    referenced_knowledge_ids: jPayload.referenced_knowledge_ids ?? [],
    created_at: j.created_at,
  };
}

// suppress unused-import warning at module level (kept for future expansion)
void sql;
