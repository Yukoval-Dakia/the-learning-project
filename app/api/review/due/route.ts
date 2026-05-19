// Phase 1c.1 Step 9.B — `/api/review/due` rewritten over `material_fsrs_state`.
//
// Pre-Step-9 the route SELECTed mistake rows where fsrs_state.due <= now() OR
// fsrs_state IS NULL. Post-Step-9 the legacy mistake table is gone; the FSRS
// projection lives in `material_fsrs_state` (one row per (kind, id) — Step 9.A).
//
// A question that has never been reviewed has NO `material_fsrs_state` row at
// all — those questions are picked up via a LEFT JOIN with NULL filter.
//
// Wire contract preserved: { rows: [{ id, question_id, prompt_md, reference_md,
// knowledge_ids, cause, fsrs_state, created_at }] }. The `id` semantically
// changes from mistake.id to question.id (opaque to clients).

import { db } from '@/db/client';
import { questionRef, type ActivityRefT } from '@/core/schema/activity';
import { material_fsrs_state, question } from '@/db/schema';
import { getFailureAttempts, getJudgeForAttempt } from '@/server/events/queries';
import { errorResponse } from '@/server/http/errors';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 200);
    const now = new Date();

    // Two slices, unioned:
    //   1. Questions with material_fsrs_state where due_at <= now() — overdue
    //      from prior reviews.
    //   2. Questions with NO material_fsrs_state row but at least one failure
    //      attempt — never-reviewed cards still owed a first pass.
    //
    // We keep them ordered: null-state cards first (legacy contract), then
    // due-earliest first.
    const dueRows = await db
      .select({
        question_id: material_fsrs_state.subject_id,
        state: material_fsrs_state.state,
        due_at: material_fsrs_state.due_at,
        prompt_md: question.prompt_md,
        reference_md: question.reference_md,
        knowledge_ids: question.knowledge_ids,
        created_at: question.created_at,
      })
      .from(material_fsrs_state)
      .innerJoin(question, eq(question.id, material_fsrs_state.subject_id))
      .where(
        and(eq(material_fsrs_state.subject_kind, 'question'), lte(material_fsrs_state.due_at, now)),
      )
      .orderBy(material_fsrs_state.due_at, question.created_at)
      .limit(limit);

    // Build the "never reviewed" slice by finding failure attempts whose
    // question has no FSRS state row yet. Use the existing event-stream read
    // path (getFailureAttempts) and filter out already-projected ids.
    const projectedQids = new Set(dueRows.map((r) => r.question_id));
    const newAttempts = await getFailureAttempts(db, { limit: limit * 2 });
    const newQuestionIds: string[] = [];
    for (const a of newAttempts) {
      if (!projectedQids.has(a.question_id) && !newQuestionIds.includes(a.question_id)) {
        newQuestionIds.push(a.question_id);
      }
    }
    const newRows: Array<{
      question_id: string;
      prompt_md: string;
      reference_md: string | null;
      knowledge_ids: string[];
      created_at: Date;
    }> = [];
    if (newQuestionIds.length > 0) {
      // Check NO material_fsrs_state row exists for these question ids
      const existing = await db
        .select({ subject_id: material_fsrs_state.subject_id })
        .from(material_fsrs_state)
        .where(
          and(
            eq(material_fsrs_state.subject_kind, 'question'),
            inArray(material_fsrs_state.subject_id, newQuestionIds),
          ),
        );
      const reviewed = new Set(existing.map((r) => r.subject_id));
      const trulyNew = newQuestionIds.filter((id) => !reviewed.has(id));
      if (trulyNew.length > 0) {
        const qRows = await db
          .select({
            id: question.id,
            prompt_md: question.prompt_md,
            reference_md: question.reference_md,
            knowledge_ids: question.knowledge_ids,
            created_at: question.created_at,
          })
          .from(question)
          .where(inArray(question.id, trulyNew));
        const qById = new Map(qRows.map((q) => [q.id, q]));
        // Preserve attempt order (newest-first from getFailureAttempts).
        for (const qid of trulyNew) {
          const q = qById.get(qid);
          if (q) {
            newRows.push({
              question_id: qid,
              prompt_md: q.prompt_md,
              reference_md: q.reference_md,
              knowledge_ids: q.knowledge_ids ?? [],
              created_at: q.created_at,
            });
          }
        }
      }
    }

    type OutRow = {
      id: string;
      activity_ref: ActivityRefT;
      question_id: string;
      prompt_md: string;
      reference_md: string | null;
      knowledge_ids: string[];
      cause: unknown;
      fsrs_state: unknown;
      created_at: Date;
    };

    // Null-state (never reviewed) rows come first, then the already-due slice.
    const combined: OutRow[] = [
      ...newRows.map((n) => ({
        id: n.question_id,
        activity_ref: questionRef(n.question_id),
        question_id: n.question_id,
        prompt_md: n.prompt_md.slice(0, 1000),
        reference_md: n.reference_md ? n.reference_md.slice(0, 1000) : null,
        knowledge_ids: n.knowledge_ids,
        cause: null,
        fsrs_state: null,
        created_at: n.created_at,
      })),
      ...dueRows.map((r) => ({
        id: r.question_id,
        activity_ref: questionRef(r.question_id),
        question_id: r.question_id,
        prompt_md: r.prompt_md.slice(0, 1000),
        reference_md: r.reference_md ? r.reference_md.slice(0, 1000) : null,
        knowledge_ids: (r.knowledge_ids as string[]) ?? [],
        cause: null,
        fsrs_state: r.state ?? null,
        created_at: r.created_at,
      })),
    ];

    return Response.json({ rows: combined.slice(0, limit) });
  } catch (err) {
    return errorResponse(err);
  }
}

// Silence unused-import warnings while keeping helpers available for future
// projections (cause via judge events, etc.)
void getJudgeForAttempt;
void desc;
void isNull;
void or;
void sql;
