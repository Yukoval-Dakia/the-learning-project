// Wave 7 T-KG (YUK-142) Slice 2 — per-knowledge-node FSRS due summary.
//
// GET /api/knowledge/review-due-summary
//   → { now: ISO, due_soon_window_hours: 24,
//       summary: { [knowledge_id]: { overdue, due_soon } } }
//
// FSRS due is tracked per QUESTION (`material_fsrs_state`, subject_kind =
// 'question', subject_id = question.id). `question.knowledge_ids` (jsonb
// string[]) links a question to one or more knowledge nodes. We join
// material_fsrs_state → question, unnest knowledge_ids, and aggregate the count
// of due questions per knowledge_id in a single GROUP BY (no N+1):
//
//   - overdue   : due_at < now
//   - due_soon  : now <= due_at < now + DUE_SOON_WINDOW_HOURS
//
// The join/predicate shape mirrors `executeGetReviewDue`
// (src/server/ai/tools/context-readers.ts): same material_fsrs_state ⨝ question
// on subject_id, same subject_kind = 'question' gate, same per-question
// knowledge_ids fan-out — but aggregated for the graph indicator instead of
// returning per-question rows. The `material_fsrs_due_idx` (on due_at) backs the
// due_at range scan.
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
import { material_fsrs_state, question } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { sql } from 'drizzle-orm';

export const runtime = 'nodejs';

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

    // Single aggregate query. Postgres forbids a set-returning function
    // (jsonb_array_elements_text) directly in GROUP BY, so the unnest happens in
    // an inner subquery (one (knowledge_id, due_at) row per question→node link;
    // XC-4: knowledge_ids is jsonb, NOT pg text[], hence jsonb_array_elements_text
    // not a pg array op), and the outer query groups by knowledge_id with FILTER
    // aggregates for the two bands. Upper bound `due_at < soonCutoff` is applied
    // in the subquery so the material_fsrs_due_idx (on due_at) backs the range
    // scan and far-future cards are dropped before the group-by; there is no
    // lower bound because overdue cards may be arbitrarily far in the past.
    const rows = (await db.execute(sql<{
      knowledge_id: string;
      overdue: number;
      due_soon: number;
    }>`
      SELECT
        link.knowledge_id AS knowledge_id,
        count(*) FILTER (WHERE link.due_at < ${nowIso}::timestamptz)::int AS overdue,
        count(*) FILTER (WHERE link.due_at >= ${nowIso}::timestamptz AND link.due_at < ${soonCutoffIso}::timestamptz)::int AS due_soon
      FROM (
        SELECT
          jsonb_array_elements_text(${question.knowledge_ids}) AS knowledge_id,
          ${material_fsrs_state.due_at} AS due_at
        FROM ${material_fsrs_state}
        INNER JOIN ${question} ON ${question.id} = ${material_fsrs_state.subject_id}
        WHERE ${material_fsrs_state.subject_kind} = 'question'
          AND ${material_fsrs_state.due_at} < ${soonCutoffIso}::timestamptz
      ) AS link
      GROUP BY link.knowledge_id
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
