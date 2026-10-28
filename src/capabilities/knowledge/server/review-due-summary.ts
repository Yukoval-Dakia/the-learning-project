// Per-node FSRS due summary: overdue and due-soon counts in one GROUP BY.
//
// Overdue includes `now`, matching the canonical review queue; due_soon starts
// strictly after it, so the bands partition cleanly.
//
// Never-reviewed cards are omitted: deriving them needs the event-log scan and
// correction filtering that the review queue does in app code.

import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { knowledge, material_fsrs_state } from '@/db/schema';

// One boundary keeps the bands gap-free. Returned in the response so the client
// does not hard-code it.
const DUE_SOON_WINDOW_HOURS = 24;

export type ReviewDueNodeSummary = { overdue: number; due_soon: number };
export type ReviewDueSummaryResponse = {
  now: string;
  due_soon_window_hours: number;
  summary: Record<string, ReviewDueNodeSummary>;
};

export async function loadReviewDueSummary(db: Db): Promise<ReviewDueSummaryResponse> {
  const now = new Date();
  const soonCutoff = new Date(now.getTime() + DUE_SOON_WINDOW_HOURS * 3_600_000);
  // Raw sql cannot bind Date; pass ISO strings with explicit timestamptz casts.
  const nowIso = now.toISOString();
  const soonCutoffIso = soonCutoff.toISOString();

  // No lower bound: overdue cards may be arbitrarily old.
  // YUK-1600 — only testable KCs carry a due summary: goal/container roots never
  // surface 复习到期 (their FSRS rows, if any, are pre-gate stock kept for evidence).
  // LEFT JOIN + ISNULL keeps the default-open rule: an orphan subject id (no live
  // node) keeps its previous behavior instead of being silently dropped here.
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
    LEFT JOIN ${knowledge} ON ${knowledge.id} = ${material_fsrs_state.subject_id}
    WHERE ${material_fsrs_state.subject_kind} = 'knowledge'
      AND (${knowledge.id} IS NULL OR ${knowledge.role} = 'kc')
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
  return body;
}
