import { db } from '@/db/client';
import { mistake, question } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { and, desc, isNull, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 100);

    const rows = await db
      .select({
        id: mistake.id,
        question_id: mistake.question_id,
        knowledge_ids: mistake.knowledge_ids,
        cause: mistake.cause,
        created_at: mistake.created_at,
        prompt_md: question.prompt_md,
        wrong_answer_md: mistake.wrong_answer_md,
      })
      .from(mistake)
      .innerJoin(question, sql`${question.id} = ${mistake.question_id}`)
      .where(and(isNull(mistake.archived_at), isNull(mistake.deleted_at)))
      .orderBy(desc(mistake.created_at))
      .limit(limit);

    const out = rows.map((r) => ({
      id: r.id,
      question_id: r.question_id,
      prompt_md: (r.prompt_md ?? '').slice(0, 200),
      wrong_answer_md: (r.wrong_answer_md ?? '').slice(0, 200),
      knowledge_ids: r.knowledge_ids,
      cause: r.cause ?? null,
      created_at: Math.floor(new Date(r.created_at).getTime() / 1000),
    }));

    return Response.json({ rows: out });
  } catch (err) {
    return errorResponse(err);
  }
}
