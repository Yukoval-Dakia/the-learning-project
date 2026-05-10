import { Hono } from 'hono';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { scheduleReview } from '../review/fsrs';
import { FsrsState, FsrsRating } from '../../../src/core/schema/business';
import type { AppEnv } from '../types';

export const review = new Hono<AppEnv>();

const SubmitBody = z.object({
  mistake_id: z.string().min(1),
  rating: FsrsRating,
  response_md: z.string().nullable().optional(),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
});

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

  // Per-row try/catch so one corrupt JSON column doesn't block the entire review queue.
  // Skipped rows are logged for follow-up — they remain in DB but stay invisible to /review.
  const out: Array<{
    id: string;
    question_id: string;
    prompt_md: string;
    reference_md: string | null;
    knowledge_ids: string[];
    cause: unknown;
    fsrs_state: unknown;
    created_at: number;
  }> = [];
  for (const r of rows.results) {
    try {
      out.push({
        id: r.id,
        question_id: r.question_id,
        prompt_md: r.prompt_md.slice(0, 1000),
        reference_md: r.reference_md ? r.reference_md.slice(0, 1000) : null,
        knowledge_ids: JSON.parse(r.knowledge_ids) as string[],
        cause: r.cause ? JSON.parse(r.cause) : null,
        fsrs_state: r.fsrs_state ? JSON.parse(r.fsrs_state) : null,
        created_at: r.created_at,
      });
    } catch (err) {
      console.error('review/due: skipping row with corrupt JSON', { mistakeId: r.id, err });
    }
  }

  return c.json({ rows: out });
});

review.post('/submit', async (c) => {
  const raw = (await c.req.json().catch(() => null)) as unknown;
  const parsed = SubmitBody.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'validation_error',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
      400,
    );
  }
  const body = parsed.data;
  const now = new Date();

  const row = await c.env.DB.prepare(
    `select id, fsrs_state, version, archived_at, deleted_at from mistake where id = ?`,
  )
    .bind(body.mistake_id)
    .first<{
      id: string;
      fsrs_state: string | null;
      version: number;
      archived_at: number | null;
      deleted_at: number | null;
    }>();

  if (!row || row.archived_at !== null || row.deleted_at !== null) {
    return c.json({ error: 'not_found', message: `mistake ${body.mistake_id} not found` }, 404);
  }

  // Plan F1: zod-coerce JSON-deserialized strings back to Date.
  // Direct JSON.parse leaves due/last_review as ISO strings; ts-fsrs would compute NaN intervals.
  // Wrap in try/catch — a corrupt or schema-drifted fsrs_state row would otherwise stick
  // forever as 5xx with no audit trail. Surface 422 with mistake_id so user can act.
  let prevState: ReturnType<typeof FsrsState.parse> | null;
  let result: ReturnType<typeof scheduleReview>;
  try {
    prevState = row.fsrs_state ? FsrsState.parse(JSON.parse(row.fsrs_state)) : null;
    result = scheduleReview(prevState, body.rating, now);
  } catch (err) {
    console.error('review submit prep failed', { mistakeId: body.mistake_id, err });
    return c.json(
      {
        error: 'corrupt_state',
        message: `mistake ${body.mistake_id} fsrs_state could not be parsed; please reset this mistake`,
      },
      422,
    );
  }

  const dueBefore = prevState ? Math.floor(prevState.due.getTime() / 1000) : null;
  const updateStmt = c.env.DB.prepare(
    `update mistake set fsrs_state = ?, updated_at = ?, version = version + 1
     where id = ? and version = ?`,
  ).bind(
    JSON.stringify(result.nextState),
    Math.floor(now.getTime() / 1000),
    body.mistake_id,
    row.version,
  );
  const insertStmt = c.env.DB.prepare(
    `insert into review_event (
       id, mistake_id, rating, response_md, latency_ms,
       fsrs_state_before, fsrs_state_after, due_at_before, due_at_next, created_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    createId(),
    body.mistake_id,
    body.rating,
    body.response_md ?? null,
    body.latency_ms ?? null,
    prevState ? JSON.stringify(prevState) : null,
    JSON.stringify(result.nextState),
    dueBefore,
    Math.floor(result.dueAt.getTime() / 1000),
    Math.floor(now.getTime() / 1000),
  );

  // Atomic via D1 batch. Hard failure → both rollback (Hono onError 5xx).
  // Version mismatch → UPDATE no-op + INSERT commits as audit-only review_event (spec § 六).
  const results = await c.env.DB.batch([updateStmt, insertStmt]);
  const updateChanges = (results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0;
  if (updateChanges !== 1) {
    return c.json(
      { error: 'conflict', message: `mistake ${body.mistake_id} was concurrently modified (audit logged)` },
      409,
    );
  }

  return c.json({
    next_due_at: Math.floor(result.dueAt.getTime() / 1000),
    new_state: result.nextState,
  });
});
