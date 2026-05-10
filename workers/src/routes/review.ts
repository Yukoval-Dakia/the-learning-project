import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const review = new Hono<AppEnv>();

review.get('/due', async (c) => {
  const limitRaw = c.req.query('limit');
  const limitParsed = limitRaw ? parseInt(limitRaw, 10) : 20;
  const limit = Math.min(Math.max(isNaN(limitParsed) ? 20 : limitParsed, 1), 50);
  const nowIso = new Date().toISOString();

  const rows = await c.env.DB.prepare(
    `select m.id, m.question_id, m.knowledge_ids, m.cause, m.fsrs_state, m.created_at,
            q.prompt_md, q.reference_md
     from mistake m
     join question q on q.id = m.question_id
     where m.archived_at is null and m.deleted_at is null and m.status = 'active'
       and (m.fsrs_state is null
            or json_extract(m.fsrs_state, '$.due') <= ?)
     order by
       (m.fsrs_state is null) desc,
       json_extract(m.fsrs_state, '$.due') asc,
       m.created_at asc
     limit ?`,
  )
    .bind(nowIso, limit)
    .all<{
      id: string;
      question_id: string;
      knowledge_ids: string;
      cause: string | null;
      fsrs_state: string | null;
      created_at: number;
      prompt_md: string;
      reference_md: string | null;
    }>();

  const out = rows.results.map((r) => ({
    id: r.id,
    question_id: r.question_id,
    prompt_md: r.prompt_md.slice(0, 1000),
    reference_md: r.reference_md ? r.reference_md.slice(0, 1000) : null,
    knowledge_ids: JSON.parse(r.knowledge_ids) as string[],
    cause: r.cause ? JSON.parse(r.cause) : null,
    fsrs_state: r.fsrs_state ? JSON.parse(r.fsrs_state) : null,
    created_at: r.created_at,
  }));

  return c.json({ rows: out });
});
