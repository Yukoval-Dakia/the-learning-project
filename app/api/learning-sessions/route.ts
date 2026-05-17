import { z } from 'zod';

import { db } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { and, desc, eq, inArray } from 'drizzle-orm';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  type: z.enum(['ingestion', 'review', 'tutor', 'explore', 'create', 'conversation']).optional(),
  status: z.string().min(1).optional(),
  limit: z
    .string()
    .min(1)
    .optional()
    .refine((s) => s === undefined || /^\d+$/.test(s), {
      message: 'limit must be a positive integer',
    })
    .transform((s) => (s === undefined ? 6 : Math.min(Number.parseInt(s, 10), 50))),
});

type Rating = 'again' | 'hard' | 'good';

const emptyRatings = (): Record<Rating, number> => ({ again: 0, hard: 0, good: 0 });

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) raw[key] = value;
    const parsed = QuerySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }

    const conditions = [];
    if (parsed.data.type) conditions.push(eq(learning_session.type, parsed.data.type));
    if (parsed.data.status) conditions.push(eq(learning_session.status, parsed.data.status));

    const base = db.select().from(learning_session);
    const sessions = await (conditions.length > 0 ? base.where(and(...conditions)) : base)
      .orderBy(desc(learning_session.started_at))
      .limit(parsed.data.limit);

    const sessionIds = sessions.map((s) => s.id);
    const statsBySession = new Map<
      string,
      {
        reviewed_count: number;
        rating_counts: Record<Rating, number>;
        knowledge_touched: Set<string>;
      }
    >();

    if (sessionIds.length > 0) {
      const reviewEvents = await db
        .select({
          session_id: event.session_id,
          payload: event.payload,
        })
        .from(event)
        .where(
          and(
            inArray(event.session_id, sessionIds),
            eq(event.action, 'review'),
            eq(event.subject_kind, 'question'),
          ),
        );

      for (const row of reviewEvents) {
        if (!row.session_id) continue;
        const stats = statsBySession.get(row.session_id) ?? {
          reviewed_count: 0,
          rating_counts: emptyRatings(),
          knowledge_touched: new Set<string>(),
        };
        const payload = row.payload as {
          fsrs_rating?: Rating;
          referenced_knowledge_ids?: string[];
        };
        stats.reviewed_count += 1;
        if (payload.fsrs_rating && payload.fsrs_rating in stats.rating_counts) {
          stats.rating_counts[payload.fsrs_rating] += 1;
        }
        for (const id of payload.referenced_knowledge_ids ?? []) stats.knowledge_touched.add(id);
        statsBySession.set(row.session_id, stats);
      }
    }

    return Response.json({
      rows: sessions.map((s) => {
        const stats = statsBySession.get(s.id) ?? {
          reviewed_count: 0,
          rating_counts: emptyRatings(),
          knowledge_touched: new Set<string>(),
        };
        const endedAt = s.ended_at ?? (s.status === 'started' ? new Date() : null);
        return {
          id: s.id,
          type: s.type,
          status: s.status,
          summary_md: s.summary_md,
          goal_id: s.goal_id,
          started_at: Math.floor(s.started_at.getTime() / 1000),
          ended_at: s.ended_at ? Math.floor(s.ended_at.getTime() / 1000) : null,
          duration_ms: endedAt ? endedAt.getTime() - s.started_at.getTime() : null,
          reviewed_count: stats.reviewed_count,
          rating_counts: stats.rating_counts,
          knowledge_touched: [...stats.knowledge_touched],
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
