// YUK-280 P4 (YUK-203) — GET /api/questions question-bank list.
// M5-T5a (YUK-321)：平移自 app/api/questions/route.ts（Hono manifest 挂载；旧壳 Task 9 拆）。
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
import { ApiError, collectionPayload, errorResponse } from '@/kernel/http';
import {
  type QuestionFamily,
  type QuestionListDraftStatus,
  type QuestionListItem,
  type QuestionListSortBy,
  type QuestionListSortDir,
  listQuestions,
} from '@/server/questions/list';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const SourceTierSchema = z.coerce.number().int().min(1).max(4);

const ListQuerySchema = z
  .object({
    knowledge_id: z.array(z.string().min(1)).default([]),
    // YUK-288 subject 派生轴 — a subject profile id (e.g. 'yuwen'); resolved to a
    // knowledge-id set server-side (never a question column).
    subject: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    difficulty: z.array(z.coerce.number().int().min(1).max(5)).default([]),
    visual_complexity: z.string().min(1).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    source_tier: z.array(SourceTierSchema).default([]),
    sort_by: z.enum(['created_at', 'source_tier', 'difficulty']).optional(),
    sort_dir: z.enum(['asc', 'desc']).optional(),
    status: z.enum(['all', 'active', 'draft']).optional(),
    group_by_family: z.boolean().default(false),
    expand_root: z.string().min(1).optional(),
    include_drafts: z.boolean().default(false),
    // YUK-409 题库面 enrichment opt-in（subject / knowledge_labels / 大题小题展开）。
    // 只对默认 flat list 路径生效——与 expand_root / group_by_family / source_tier /
    // sort_by 互斥（那些是 in-memory derive 路径，不补 enrichment）。
    enrich: z.boolean().default(false),
    limit: z.coerce.number().int().default(DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
    cursor: z.string().min(1).optional(),
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
      difficulty: sp.getAll('difficulty'),
      visual_complexity: sp.get('visual_complexity') ?? undefined,
      search: sp.get('search') ?? undefined,
      source_tier: sp.getAll('source_tier'),
      sort_by: sp.get('sort_by') ?? undefined,
      sort_dir: sp.get('sort_dir') ?? undefined,
      status: sp.get('status') ?? undefined,
      group_by_family: parseBool(sp.get('group_by_family')),
      expand_root: sp.get('expand_root') ?? undefined,
      include_drafts: parseBool(sp.get('include_drafts')),
      enrich: parseBool(sp.get('enrich')),
      limit: sp.get('limit') ?? undefined,
      offset: sp.get('offset') ?? undefined,
      cursor: sp.get('cursor') ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const q = parsed.data;

    if (q.cursor && sp.has('offset')) {
      throw new ApiError('invalid_cursor', 'cursor and offset are mutually exclusive', 400);
    }
    if (
      q.cursor &&
      (q.group_by_family ||
        q.expand_root !== undefined ||
        q.source_tier.length > 0 ||
        q.sort_by === 'source_tier')
    ) {
      throw new ApiError(
        'invalid_cursor',
        'cursor pagination is available for flat created_at/difficulty question lists',
        400,
      );
    }

    const limit = Math.min(Math.max(q.limit, 1), MAX_LIMIT);
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
      difficulties: q.difficulty.length > 0 ? q.difficulty : undefined,
      visualComplexity: q.visual_complexity,
      search: q.search,
      sourceTier: q.source_tier.length > 0 ? (q.source_tier as (1 | 2 | 3 | 4)[]) : undefined,
      sortBy: q.sort_by as QuestionListSortBy | undefined,
      sortDir: q.sort_dir as QuestionListSortDir | undefined,
      groupByFamily: q.group_by_family,
      expandRoot: q.expand_root,
      includeDrafts: q.include_drafts,
      draftStatus: q.status as QuestionListDraftStatus | undefined,
      enrich: q.enrich,
      limit,
      offset,
      cursor: q.cursor,
    });

    const data: Array<QuestionFamily | QuestionListItem> = result.families ?? result.items;
    return Response.json(
      collectionPayload<QuestionFamily | QuestionListItem, typeof result>(
        data,
        result.page,
        result,
      ),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
