// Phase 1c.1 Step 6 — `/api/mistakes/recent` rewritten over the event stream.
//
// Wire contract unchanged from the legacy mistake-shape:
//   GET /api/mistakes/recent?limit=N
//     → { rows: [{ id, question_id, prompt_md, wrong_answer_md, knowledge_ids,
//                  cause, created_at }] }
//
// Implementation reads failure attempts from the event log via
// `getFailureAttempts` (Step 4) then projects to mistake-shape JSON. Question
// prompts are batch-fetched via `inArray` to avoid N+1.
//
// `cause.user_notes` is preserved as `null` for back-compat (Lane B dropped
// the field per ADR-0006 v2; product accepts the data loss).

import { inArray } from 'drizzle-orm';

import { db } from '@/db/client';
import { question } from '@/db/schema';
import { getFailureAttempts } from '@/server/events/queries';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 100);

    const fails = await getFailureAttempts(db, { limit });
    if (fails.length === 0) return Response.json({ rows: [] });

    const questionIds = [...new Set(fails.map((f) => f.question_id))];
    const questions = await db
      .select({ id: question.id, prompt_md: question.prompt_md })
      .from(question)
      .where(inArray(question.id, questionIds));
    const promptByQid = new Map(questions.map((q) => [q.id, q.prompt_md]));

    // Phase 1c.2 — cause projection prefers the user_cause event (the user has
    // the last word) and falls back to the agent judge. `source` is added to
    // the wire so the UI can render provenance.
    const rows = fails.map((f) => {
      const cause = f.user_cause
        ? {
            source: 'user' as const,
            primary_category: f.user_cause.primary_category,
            user_notes: f.user_cause.user_notes,
          }
        : f.judge
          ? {
              source: 'agent' as const,
              primary_category: f.judge.cause.primary_category,
              user_notes: null,
            }
          : null;
      return {
        id: f.attempt_event_id,
        question_id: f.question_id,
        prompt_md: (promptByQid.get(f.question_id) ?? '').slice(0, 200),
        wrong_answer_md: (f.answer_md ?? '').slice(0, 200),
        knowledge_ids: f.referenced_knowledge_ids,
        cause,
        created_at: Math.floor(f.created_at.getTime() / 1000),
      };
    });

    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
