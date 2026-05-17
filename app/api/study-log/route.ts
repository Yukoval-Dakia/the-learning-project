// Phase 1c.2 — StudyLog CRUD (cross-cutting user notes; 5 kinds).
//
// study_log schema:
//   { id, kind, content_md, knowledge_ids[], question_id?, mistake_id?,
//     artifact_id?, learning_item_id?, created_at, updated_at, version }
//
// kind enum (per docs/architecture.md + memory):
//   highlight   — 刚看到的好句 / 公式 / 概念
//   insight     — 顿悟、灵光一闪
//   question    — 没解决的疑问（cross-cutting，不替代 mistake.cause.user_notes）
//   reflection  — 阶段性反思 / 复盘
//   observation — 观察到的规律 / 现象

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { knowledge, study_log } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const KIND = ['highlight', 'insight', 'question', 'reflection', 'observation'] as const;

const ListQuery = z.object({
  kind: z.enum(KIND).optional(),
  knowledge_id: z.string().min(1).optional(),
  limit: z
    .string()
    .optional()
    .refine((s) => s === undefined || /^\d+$/.test(s), {
      message: 'limit must be a positive integer',
    }),
});

const CreateBody = z.object({
  kind: z.enum(KIND),
  content_md: z.string().min(1).max(10_000),
  knowledge_ids: z.array(z.string().min(1)).default([]),
  question_id: z.string().min(1).nullish(),
  mistake_id: z.string().min(1).nullish(),
  artifact_id: z.string().min(1).nullish(),
  learning_item_id: z.string().min(1).nullish(),
});

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v;
    const parsed = ListQuery.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const limit = Math.min(
      Math.max(parsed.data.limit ? Number.parseInt(parsed.data.limit, 10) : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    const filters = [];
    if (parsed.data.kind) filters.push(eq(study_log.kind, parsed.data.kind));

    const baseQuery = db.select().from(study_log);
    const filtered = filters.length > 0 ? baseQuery.where(and(...filters)) : baseQuery;
    const rows = await filtered.orderBy(desc(study_log.created_at)).limit(limit);

    // knowledge_id filter is post-fetch since it lives inside the jsonb array;
    // bounded by limit so it stays cheap.
    const filteredRows = parsed.data.knowledge_id
      ? rows.filter((r) => (r.knowledge_ids as string[]).includes(parsed.data.knowledge_id ?? ''))
      : rows;

    return Response.json({
      rows: filteredRows.map((r) => ({
        ...r,
        created_at: Math.floor(r.created_at.getTime() / 1000),
        updated_at: Math.floor(r.updated_at.getTime() / 1000),
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = CreateBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const body = parsed.data;

    if (body.knowledge_ids.length > 0) {
      const found = await db
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(and(inArray(knowledge.id, body.knowledge_ids), isNull(knowledge.archived_at)));
      const foundIds = new Set(found.map((r) => r.id));
      const missing = body.knowledge_ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new ApiError(
          'validation_error',
          `unknown or archived knowledge_ids: ${missing.join(', ')}`,
          400,
        );
      }
    }

    const id = createId();
    const now = new Date();
    await db.insert(study_log).values({
      id,
      kind: body.kind,
      content_md: body.content_md,
      knowledge_ids: body.knowledge_ids,
      question_id: body.question_id ?? null,
      mistake_id: body.mistake_id ?? null,
      artifact_id: body.artifact_id ?? null,
      learning_item_id: body.learning_item_id ?? null,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    return Response.json({
      id,
      kind: body.kind,
      content_md: body.content_md,
      knowledge_ids: body.knowledge_ids,
      created_at: Math.floor(now.getTime() / 1000),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
