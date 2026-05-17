import { db } from '@/db/client';
import { learning_item } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { assertKnowledgeIdsExist } from '@/server/knowledge/validate';
import { createId } from '@paralleldrive/cuid2';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

export const runtime = 'nodejs';

const ListQuery = z.object({
  status: z.enum(['pending', 'in_progress', 'done', 'dismissed', 'resting', 'archived']).optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const statusRaw = url.searchParams.get('status') ?? undefined;
    const limitRaw = url.searchParams.get('limit');
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
    const limit = Math.min(Math.max(Number.isNaN(limitParsed) ? 50 : limitParsed, 1), 200);

    const parsedStatus = ListQuery.safeParse({ status: statusRaw });
    if (!parsedStatus.success) {
      return Response.json(
        { error: 'validation_error', message: 'invalid status filter' },
        { status: 400 },
      );
    }
    const status = parsedStatus.data.status;

    // Default list excludes archived + dismissed (they're the "out of sight"
    // pile). Explicit ?status=archived / dismissed surfaces them on demand.
    const filters = [];
    if (status) {
      filters.push(eq(learning_item.status, status));
    } else {
      filters.push(isNull(learning_item.archived_at));
      filters.push(ne(learning_item.status, 'dismissed'));
    }

    const rows = await db
      .select({
        id: learning_item.id,
        title: learning_item.title,
        content: learning_item.content,
        knowledge_ids: learning_item.knowledge_ids,
        status: learning_item.status,
        completed_at: learning_item.completed_at,
        created_at: learning_item.created_at,
        updated_at: learning_item.updated_at,
        version: learning_item.version,
      })
      .from(learning_item)
      .where(and(...filters))
      .orderBy(
        sql`case ${learning_item.status}
          when 'pending' then 0
          when 'in_progress' then 1
          when 'done' then 2
          when 'resting' then 3
          when 'dismissed' then 4
          when 'archived' then 5
          else 6
        end asc`,
        desc(learning_item.updated_at),
      )
      .limit(limit);

    const out = rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      knowledge_ids: r.knowledge_ids,
      status: r.status,
      completed_at: r.completed_at ? Math.floor(r.completed_at.getTime() / 1000) : null,
      created_at: Math.floor(r.created_at.getTime() / 1000),
      updated_at: Math.floor(r.updated_at.getTime() / 1000),
      version: r.version,
    }));

    return Response.json({ rows: out });
  } catch (err) {
    return errorResponse(err);
  }
}

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(10_000).optional().default(''),
  knowledge_ids: z.array(z.string().min(1)).default([]),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = CreateBody.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        {
          error: 'validation_error',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        { status: 400 },
      );
    }
    const body = parsed.data;

    if (body.knowledge_ids.length > 0) {
      const check = await assertKnowledgeIdsExist(db, body.knowledge_ids);
      if (!check.ok) {
        return Response.json(
          {
            error: 'validation_error',
            message: `unknown knowledge_ids: ${check.missing.join(', ')}`,
          },
          { status: 400 },
        );
      }
    }

    const id = createId();
    const now = new Date();

    await db.insert(learning_item).values({
      id,
      source: 'manual',
      title: body.title,
      content: body.content,
      knowledge_ids: body.knowledge_ids,
      status: 'pending',
      user_pinned: false,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    return Response.json({
      id,
      title: body.title,
      content: body.content,
      knowledge_ids: body.knowledge_ids,
      status: 'pending',
      completed_at: null,
      created_at: Math.floor(now.getTime() / 1000),
      updated_at: Math.floor(now.getTime() / 1000),
      version: 0,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
