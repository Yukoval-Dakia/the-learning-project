// Wave 7 T-KG (YUK-142) Slice 2 — per-knowledge-node FSRS due summary.
//
// GET /api/knowledge/review-due-summary
//   → { now: ISO, due_soon_window_hours: 24,
//       summary: { [knowledge_id]: { overdue, due_soon } } }
//
// YUK-203 P3: FSRS due is tracked per KNOWLEDGE point
// (`material_fsrs_state`, subject_kind='knowledge', subject_id=knowledge.id).
// Aggregate due knowledge cards directly in a single GROUP BY (no N+1):
//
//   - overdue   : due_at <= now
//   - due_soon  : now < due_at < now + DUE_SOON_WINDOW_HOURS
//
// The overdue boundary is INCLUSIVE of `now` to match the canonical review
// queue `executeGetReviewDue` (src/server/ai/tools/context-readers.ts), which
// gates overdue with `lte(material_fsrs_state.due_at, now)` — a card due exactly
// at `now` is overdue, not due_soon. due_soon therefore starts strictly after
// now (> now), keeping the two bands a clean partition with no gap/overlap.
//
// The `material_fsrs_due_idx` (on due_at) backs the due_at range scan.
//
// `never_reviewed` (questions with failure attempts but no FSRS row) is
// deliberately OMITTED: deriving it needs the event-log failure scan +
// effective-correction filtering that `executeGetReviewDue` runs in app code,
// which can't fold into this one aggregate GROUP BY. The graph indicator only
// needs the actionable "今天该复习" (overdue / due-soon) signal; the never-
// reviewed slice stays the job of /api/review/due + get_review_due.
//
// Auth: enforced by middleware.ts (x-internal-token); this handler stays
// auth-agnostic like its neighbours (route.ts / edges/route.ts).

import { db } from '@/db/client';
import { material_fsrs_state } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { sql } from 'drizzle-orm';


// Window for the "due soon" band: cards becoming due within the next day. Kept
// as a single boundary (not 24-48h) so overdue and due_soon partition the due
// horizon cleanly with no gap/overlap. Documented in the response so the client
// never hard-codes it.
const DUE_SOON_WINDOW_HOURS = 24;

export type ReviewDueNodeSummary = { overdue: number; due_soon: number };
export type ReviewDueSummaryResponse = {
  now: string;
  due_soon_window_hours: number;
  summary: Record<string, ReviewDueNodeSummary>;
};

export async function GET(): Promise<Response> {
  try {
    const now = new Date();
    const soonCutoff = new Date(now.getTime() + DUE_SOON_WINDOW_HOURS * 3_600_000);
    // The postgres-js driver does not serialize a JS Date bound into a raw
    // `sql` template (it throws ERR_INVALID_ARG_TYPE: "Received an instance of
    // Date" before the query is even sent). Bind ISO strings + explicit
    // ::timestamptz casts instead, matching how other raw db.execute() callers
    // pass scalars (see src/server/knowledge/review.ts, which uses NOW()).
    const nowIso = now.toISOString();
    const soonCutoffIso = soonCutoff.toISOString();

    // Single aggregate query. Upper bound `due_at < soonCutoff` keeps far-future
    // cards out before the group-by; there is no lower bound because overdue
    // knowledge cards may be arbitrarily far in the past.
    const rows = (await db.execute(sql<{
      knowledge_id: string;
      overdue: number;
      due_soon: number;
    }>`
      SELECT
        ${material_fsrs_state.subject_id} AS knowledge_id,
        count(*) FILTER (WHERE ${material_fsrs_state.due_at} <= ${nowIso}::timestamptz)::int AS overdue,
        count(*) FILTER (WHERE ${material_fsrs_state.due_at} > ${nowIso}::timestamptz AND ${material_fsrs_state.due_at} < ${soonCutoffIso}::timestamptz)::int AS due_soon
      FROM ${material_fsrs_state}
      WHERE ${material_fsrs_state.subject_kind} = 'knowledge'
        AND ${material_fsrs_state.due_at} < ${soonCutoffIso}::timestamptz
      GROUP BY ${material_fsrs_state.subject_id}
    `)) as unknown as Array<{ knowledge_id: string; overdue: number; due_soon: number }>;

    const summary: Record<string, ReviewDueNodeSummary> = {};
    for (const row of rows) {
      if (!row.knowledge_id) continue;
      summary[row.knowledge_id] = {
        overdue: Number(row.overdue ?? 0),
        due_soon: Number(row.due_soon ?? 0),
      };
    }

    const body: ReviewDueSummaryResponse = {
      now: now.toISOString(),
      due_soon_window_hours: DUE_SOON_WINDOW_HOURS,
      summary,
    };
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
