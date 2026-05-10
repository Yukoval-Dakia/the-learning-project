import { Hono } from 'hono';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import type { D1Database } from '@cloudflare/workers-types';
import type { AppEnv } from '../types';

export const learningItems = new Hono<AppEnv>();

async function assertKnowledgeIdsExist(
  db: D1Database,
  ids: string[],
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const missing: string[] = [];
  for (const id of ids) {
    const row = await db
      .prepare(`select id from knowledge where id = ? and archived_at is null`)
      .bind(id)
      .first();
    if (!row) missing.push(id);
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}

const ListQuery = z.object({
  status: z.enum(['pending', 'in_progress', 'done']).optional(),
});

learningItems.get('/', async (c) => {
  const statusRaw = c.req.query('status');
  const limitRaw = c.req.query('limit');
  const limitParsed = limitRaw ? parseInt(limitRaw, 10) : 50;
  const limit = Math.min(Math.max(isNaN(limitParsed) ? 50 : limitParsed, 1), 200);
  const parsedStatus = ListQuery.safeParse({ status: statusRaw });
  if (!parsedStatus.success) {
    return c.json({ error: 'validation_error', message: 'invalid status filter' }, 400);
  }
  const status = parsedStatus.data.status ?? null;

  const rows = await c.env.DB.prepare(
    `select id, title, content, knowledge_ids, status, completed_at,
            created_at, updated_at, version
     from learning_item
     where archived_at is null and status != 'dismissed'
       and (? is null or status = ?)
     order by case status
       when 'pending' then 0
       when 'in_progress' then 1
       when 'done' then 2
       else 3
     end asc, updated_at desc
     limit ?`,
  )
    .bind(status, status, limit)
    .all<{
      id: string;
      title: string;
      content: string;
      knowledge_ids: string;
      status: string;
      completed_at: number | null;
      created_at: number;
      updated_at: number;
      version: number;
    }>();

  // Per-row try/catch — Sub 4A pattern; one corrupt row shouldn't kill the list.
  const out: Array<unknown> = [];
  for (const r of rows.results) {
    try {
      out.push({
        id: r.id,
        title: r.title,
        content: r.content,
        knowledge_ids: JSON.parse(r.knowledge_ids) as string[],
        status: r.status,
        completed_at: r.completed_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
        version: r.version,
      });
    } catch (err) {
      console.error('learning-items: skipping row with corrupt JSON', { id: r.id, err });
    }
  }
  return c.json({ rows: out });
});

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(10_000).optional().default(''),
  knowledge_ids: z.array(z.string().min(1)).default([]),
});

learningItems.post('/', async (c) => {
  const raw = (await c.req.json().catch(() => null)) as unknown;
  const parsed = CreateBody.safeParse(raw);
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

  if (body.knowledge_ids.length > 0) {
    const check = await assertKnowledgeIdsExist(c.env.DB, body.knowledge_ids);
    if (!check.ok) {
      return c.json(
        { error: 'validation_error', message: `unknown knowledge_ids: ${check.missing.join(', ')}` },
        400,
      );
    }
  }

  const id = createId();
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.prepare(
    `insert into learning_item (
      id, source, title, content, knowledge_ids, status, user_pinned,
      created_at, updated_at, version
    ) values (?, 'manual', ?, ?, ?, 'pending', 0, ?, ?, 0)`,
  )
    .bind(id, body.title, body.content, JSON.stringify(body.knowledge_ids), now, now)
    .run();

  return c.json({
    id,
    title: body.title,
    content: body.content,
    knowledge_ids: body.knowledge_ids,
    status: 'pending' as const,
    completed_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
});
