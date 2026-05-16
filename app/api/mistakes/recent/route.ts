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

import { desc, inArray } from 'drizzle-orm';
import type { z } from 'zod';

import type { Cause } from '@/core/schema/business';
import { db } from '@/db/client';
import { mistake, question } from '@/db/schema';
import { getFailureAttempts } from '@/server/events/queries';
import { errorResponse } from '@/server/http/errors';

type CauseT = z.infer<typeof Cause>;

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

    // Codex P1-B — LEFT JOIN equivalent for legacy `mistake.cause`. POST stores
    // user-supplied causes on the mistake row without writing a judge event;
    // reading judge-only would silently drop them.
    // TODO Step 9: legacy mistake.cause read removed when table drops; user_cause
    // moves to experimental event (Phase 1c.2).
    const legacyMistakeRows = await db
      .select({
        question_id: mistake.question_id,
        cause: mistake.cause,
      })
      .from(mistake)
      .where(inArray(mistake.question_id, questionIds))
      .orderBy(desc(mistake.created_at));
    const legacyCauseByQid = new Map<string, CauseT | null>();
    for (const row of legacyMistakeRows) {
      // First (most recent) wins per question; older mistakes are ignored.
      if (!legacyCauseByQid.has(row.question_id)) {
        legacyCauseByQid.set(row.question_id, row.cause);
      }
    }

    const rows = fails.map((f) => {
      let cause: { primary_category: string; user_notes: string | null } | null = null;
      if (f.judge) {
        // Judge-event cause wins (AI-attributed or canonical).
        cause = { primary_category: f.judge.cause.primary_category, user_notes: null };
      } else {
        // Fallback: legacy mistake.cause preserves user-supplied causes.
        const legacy = legacyCauseByQid.get(f.question_id);
        if (legacy) {
          cause = {
            primary_category: legacy.primary_category,
            user_notes: legacy.user_notes ?? null,
          };
        }
      }
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
