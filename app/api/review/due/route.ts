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

import { type ActivityRefT, questionRef } from '@/core/schema/activity';
import type { CauseCategoryT } from '@/core/schema/event/blocks';
import { db } from '@/db/client';
import { event, material_fsrs_state, question } from '@/db/schema';
import { effectiveCauseCategoryForFailureAttempt } from '@/server/events/cause-policy';
import { type FailureAttempt, getFailureAttempts } from '@/server/events/queries';
import { errorResponse } from '@/server/http/errors';
import type { EffectiveTruth } from '@/server/review/effective-truth';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

function pickLatestFailureByQuestion(failures: FailureAttempt[]): Map<
  string,
  {
    id: string;
    cause: CauseCategoryT | null;
    created_at: Date;
    correction_state: EffectiveTruth;
  }
> {
  const out = new Map<
    string,
    {
      id: string;
      cause: CauseCategoryT | null;
      created_at: Date;
      correction_state: EffectiveTruth;
    }
  >();
  for (const failure of failures) {
    const existing = out.get(failure.question_id);
    if (existing && existing.created_at > failure.created_at) continue;
    out.set(failure.question_id, {
      id: failure.attempt_event_id,
      cause: effectiveCauseCategoryForFailureAttempt(failure),
      created_at: failure.created_at,
      correction_state: failure.correction_state,
    });
  }
  return out;
}

async function loadLatestFailureQuestionIds(candidateLimit: number): Promise<string[]> {
  const rows = (await db.execute(sql<{ question_id: string }>`
    SELECT subject_id AS question_id
    FROM (
      SELECT
        subject_id,
        created_at,
        id,
        row_number() OVER (PARTITION BY subject_id ORDER BY created_at DESC, id DESC) AS rn
      FROM event
      WHERE action = 'attempt'
        AND subject_kind = 'question'
        AND outcome = 'failure'
    ) ranked
    WHERE rn = 1
    ORDER BY created_at DESC, id DESC
    LIMIT ${candidateLimit}
  `)) as unknown as Array<{ question_id: string }>;
  return rows.map((row) => row.question_id);
}

async function getFailureAttemptsPerQuestion(
  questionIds: string[],
  perQuestionLimit: number,
): Promise<FailureAttempt[]> {
  if (questionIds.length === 0 || perQuestionLimit <= 0) return [];
  const attempts = await getFailureAttempts(db, { questionIds, limit: null });
  const countByQuestion = new Map<string, number>();
  return attempts.filter((attempt) => {
    const count = countByQuestion.get(attempt.question_id) ?? 0;
    if (count >= perQuestionLimit) return false;
    countByQuestion.set(attempt.question_id, count + 1);
    return true;
  });
}

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
    const candidateQuestionIds = (
      await loadLatestFailureQuestionIds(Math.min(Math.max(limit * 4, 100), 400))
    ).filter((questionId) => !projectedQids.has(questionId));
    const newAttempts = await getFailureAttemptsPerQuestion(candidateQuestionIds, 4);
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
    const dueQuestionIds = dueRows.map((row) => row.question_id);
    const dueAttempts = await getFailureAttemptsPerQuestion(dueQuestionIds, 4);
    const latestFailureByQid = pickLatestFailureByQuestion([...newAttempts, ...dueAttempts]);

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
      last_failure_event: { id: string; correction_state: EffectiveTruth } | null;
    };

    // Null-state (never reviewed) rows come first, then the already-due slice.
    const combined: OutRow[] = [
      ...newRows.map((n) => {
        const latestFailure = latestFailureByQid.get(n.question_id) ?? null;
        return {
          id: n.question_id,
          activity_ref: questionRef(n.question_id),
          question_id: n.question_id,
          prompt_md: n.prompt_md.slice(0, 1000),
          reference_md: n.reference_md ? n.reference_md.slice(0, 1000) : null,
          knowledge_ids: n.knowledge_ids,
          cause: latestFailure?.cause ?? null,
          fsrs_state: null,
          created_at: n.created_at,
          last_failure_event: latestFailure
            ? { id: latestFailure.id, correction_state: latestFailure.correction_state }
            : null,
        };
      }),
      ...dueRows.map((r) => {
        const latestFailure = latestFailureByQid.get(r.question_id) ?? null;
        return {
          id: r.question_id,
          activity_ref: questionRef(r.question_id),
          question_id: r.question_id,
          prompt_md: r.prompt_md.slice(0, 1000),
          reference_md: r.reference_md ? r.reference_md.slice(0, 1000) : null,
          knowledge_ids: (r.knowledge_ids as string[]) ?? [],
          cause: latestFailure?.cause ?? null,
          fsrs_state: r.state ?? null,
          created_at: r.created_at,
          last_failure_event: latestFailure
            ? { id: latestFailure.id, correction_state: latestFailure.correction_state }
            : null,
        };
      }),
    ];

    return Response.json({ rows: combined.slice(0, limit) });
  } catch (err) {
    return errorResponse(err);
  }
}
