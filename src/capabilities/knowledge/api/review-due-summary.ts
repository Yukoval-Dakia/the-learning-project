// Per-node FSRS due summary: overdue and due-soon counts in one GROUP BY.
//
// Overdue includes `now`, matching the canonical review queue; due_soon starts
// strictly after it, so the bands partition cleanly.
//
// Never-reviewed cards are omitted: deriving them needs the event-log scan and
// correction filtering that the review queue does in app code. Auth is enforced
// upstream by the internal-token middleware.

import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { material_fsrs_state } from '@/db/schema';
import { errorResponse } from '@/kernel/http';

// One boundary keeps the bands gap-free. Returned in the response so the client
// does not hard-code it.
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
    // Raw sql cannot bind Date; pass ISO strings with explicit timestamptz casts.
    const nowIso = now.toISOString();
    const soonCutoffIso = soonCutoff.toISOString();

    // No lower bound: overdue cards may be arbitrarily old.
    const rows = await db.execute<{
      knowledge_id: string;
      overdue: number;
      due_soon: number;
    }>(sql`
      SELECT
        ${material_fsrs_state.subject_id} AS knowledge_id,
        count(*) FILTER (WHERE ${material_fsrs_state.due_at} <= ${nowIso}::timestamptz)::int AS overdue,
        count(*) FILTER (WHERE ${material_fsrs_state.due_at} > ${nowIso}::timestamptz AND ${material_fsrs_state.due_at} < ${soonCutoffIso}::timestamptz)::int AS due_soon
      FROM ${material_fsrs_state}
      WHERE ${material_fsrs_state.subject_kind} = 'knowledge'
        AND ${material_fsrs_state.due_at} < ${soonCutoffIso}::timestamptz
      GROUP BY ${material_fsrs_state.subject_id}
    `);

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
