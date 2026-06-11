// YUK-280 P4 (YUK-203) — GET /api/questions question-bank list.
//
// docs/superpowers/plans/2026-06-07-yuk280-question-bank-api.md §2 (A1a/A1b/A1c)
//
// Multi-axis question-bank list: SQL axes (knowledge_id / source / kind /
// difficulty / visual_complexity / draft) + in-memory grounding tier filter/sort
// + variant-family aggregate/expand. Auth is enforced upstream by middleware
// (x-internal-token); the handler mirrors the sibling list routes (zod safeParse,
// clamp, errorResponse) and the learning-items pagination convention.

import { z } from 'zod';

import { resolveSubjectKnowledgeIds } from '@/capabilities/knowledge/server/domain';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { type QuestionListSortBy, listQuestions } from '@/server/questions/list';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SourceTierSchema = z.coerce.number().int().min(1).max(4);

const ListQuerySchema = z
  .object({
    knowledge_id: z.array(z.string().min(1)).default([]),
    // YUK-288 subject 派生轴 — a subject profile id (e.g. 'wenyan'); resolved to a
    // knowledge-id set server-side (never a question column).
    subject: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    difficulty: z.coerce.number().int().min(1).max(5).optional(),
    visual_complexity: z.string().min(1).optional(),
    source_tier: z.array(SourceTierSchema).default([]),
    sort_by: z.enum(['created_at', 'source_tier']).optional(),
    group_by_family: z.boolean().default(false),
    expand_root: z.string().min(1).optional(),
    include_drafts: z.boolean().default(false),
    limit: z.coerce.number().int().default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  // Path modes are mutually exclusive; combining them is ambiguous → reject (400)
  // rather than silently picking a precedence (plan §A1c).
  .refine((v) => !(v.expand_root !== undefined && v.group_by_family), {
    message: 'expand_root and group_by_family are mutually exclusive',
  })
  .refine((v) => !(v.expand_root !== undefined && v.source_tier.length > 0), {
    message: 'expand_root cannot be combined with source_tier',
  })
  .refine((v) => !(v.expand_root !== undefined && v.sort_by !== undefined), {
    message: 'expand_root cannot be combined with sort_by',
  });

function parseBool(raw: string | null): boolean {
  return raw === '1' || raw === 'true';
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const sp = url.searchParams;

    const parsed = ListQuerySchema.safeParse({
      knowledge_id: sp.getAll('knowledge_id'),
      subject: sp.get('subject') ?? undefined,
      source: sp.get('source') ?? undefined,
      kind: sp.get('kind') ?? undefined,
      difficulty: sp.get('difficulty') ?? undefined,
      visual_complexity: sp.get('visual_complexity') ?? undefined,
      source_tier: sp.getAll('source_tier'),
      sort_by: sp.get('sort_by') ?? undefined,
      group_by_family: parseBool(sp.get('group_by_family')),
      expand_root: sp.get('expand_root') ?? undefined,
      include_drafts: parseBool(sp.get('include_drafts')),
      limit: sp.get('limit') ?? undefined,
      offset: sp.get('offset') ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const q = parsed.data;

    const limit = Math.min(Math.max(Number.isNaN(q.limit) ? DEFAULT_LIMIT : q.limit, 1), MAX_LIMIT);
    const offset = Math.max(q.offset, 0);

    // YUK-288 subject 派生轴: resolve the subject profile id to its knowledge-id
    // set BEFORE the list query so the list ANDs an OR-of-containment over it.
    // undefined → no subject filter; [] → subject labels no questions → empty list.
    const subjectKnowledgeIds =
      q.subject !== undefined ? await resolveSubjectKnowledgeIds(db, q.subject) : undefined;

    const result = await listQuestions(db, {
      knowledgeIds: q.knowledge_id.length > 0 ? q.knowledge_id : undefined,
      subjectKnowledgeIds,
      source: q.source,
      kind: q.kind,
      difficulty: q.difficulty,
      visualComplexity: q.visual_complexity,
      sourceTier: q.source_tier.length > 0 ? (q.source_tier as (1 | 2 | 3 | 4)[]) : undefined,
      sortBy: q.sort_by as QuestionListSortBy | undefined,
      groupByFamily: q.group_by_family,
      expandRoot: q.expand_root,
      includeDrafts: q.include_drafts,
      limit,
      offset,
    });

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
