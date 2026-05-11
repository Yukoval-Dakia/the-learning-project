import { db } from '@/db/client';
import { mistake, question } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 200);
    const nowIso = new Date().toISOString();

    const rows = await db
      .select({
        id: mistake.id,
        question_id: mistake.question_id,
        knowledge_ids: mistake.knowledge_ids,
        cause: mistake.cause,
        fsrs_state: mistake.fsrs_state,
        created_at: mistake.created_at,
        prompt_md: question.prompt_md,
        reference_md: question.reference_md,
      })
      .from(mistake)
      .innerJoin(question, eq(question.id, mistake.question_id))
      .where(
        and(
          isNull(mistake.archived_at),
          isNull(mistake.deleted_at),
          eq(mistake.status, 'active'),
          or(
            isNull(mistake.fsrs_state),
            sql`(${mistake.fsrs_state}->>'due')::timestamptz <= ${nowIso}::timestamptz`,
          ),
        ),
      )
      .orderBy(
        sql`(${mistake.fsrs_state} is null) desc`,
        sql`(${mistake.fsrs_state}->>'due')::timestamptz asc nulls first`,
        mistake.created_at,
      )
      .limit(limit);

    const out: Array<{
      id: string;
      question_id: string;
      prompt_md: string;
      reference_md: string | null;
      knowledge_ids: string[];
      cause: unknown;
      fsrs_state: unknown;
      created_at: Date;
    }> = [];

    for (const r of rows) {
      try {
        out.push({
          id: r.id,
          question_id: r.question_id,
          prompt_md: r.prompt_md.slice(0, 1000),
          reference_md: r.reference_md ? r.reference_md.slice(0, 1000) : null,
          knowledge_ids: r.knowledge_ids,
          cause: r.cause ?? null,
          fsrs_state: r.fsrs_state ?? null,
          created_at: r.created_at,
        });
      } catch (err) {
        console.error('review/due: skipping row with corrupt data', { mistakeId: r.id, err });
      }
    }

    return Response.json({ rows: out });
  } catch (err) {
    return errorResponse(err);
  }
}
