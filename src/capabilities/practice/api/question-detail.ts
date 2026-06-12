// YUK-280 P4 (YUK-203) — GET /api/questions/[id]: the question-bank detail read.
// YUK-281 (YUK-203) — PATCH (edit) + DELETE (archive w/ association-count guard).
// M5-T5a (YUK-321)：平移自 app/api/questions/[id]/route.ts（Hono manifest 挂载，
// [id] 由 toHonoPath 转 :id 捕获后以 Record 透传；旧壳 Task 9 拆）。
//
// docs/superpowers/plans/2026-06-07-yuk280-question-bank-api.md §2 (A1d/A1e)
//
// GET: single-fetch detail aggregator (row + source_tier + labels + variant
// family + per-knowledge FSRS/decay + backlinks + timeline).
// PATCH: edit the question-bank editable surface (prompt/reference/choices/
//   difficulty/knowledge_ids/kind/draft_status); bloodline fields rejected.
// DELETE: returns association counts + 409 unless ?confirm=true; soft-archives
//   by re-drafting (see src/server/questions/write.ts header).
//
// Auth is enforced upstream by middleware (x-internal-token); the handlers mirror
// the sibling notes/learning-items routes (zod, 404 on missing, errorResponse).

import { z } from 'zod';

import { assertKnowledgeIdsExist } from '@/capabilities/knowledge/server/validate';
import { QuestionKind } from '@/core/schema/business';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { loadQuestionDetail } from '@/server/questions/detail';
import {
  BLOODLINE_FIELDS,
  archiveQuestion,
  countQuestionAssociations,
  editQuestion,
  hasAnyAssociation,
} from '@/server/questions/write';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

// ── PATCH body (YUK-281) ─────────────────────────────────────────────────────
// Editable surface only. Bloodline fields (variant_depth / root_question_id /
// parent_variant_id / parent_question_id / part_index) are explicitly forbidden
// — we reject the WHOLE request (rather than silently dropping them) so a UI bug
// that tries to mutate lineage fails loudly. Enums reuse the core schema.
const PatchBody = z
  .object({
    version: z.number().int().min(0),
    prompt_md: z.string().min(1).optional(),
    reference_md: z.string().nullable().optional(),
    choices_md: z.array(z.string().min(1)).nullable().optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    knowledge_ids: z.array(z.string().min(1)).optional(),
    kind: QuestionKind.optional(),
    draft_status: z.enum(['draft', 'active']).nullable().optional(),
  })
  .strict(); // unknown keys (incl. bloodline) → zod error

// Distinct, friendlier error when a bloodline field is the offender.
function rejectBloodlineKeys(raw: unknown): void {
  if (raw && typeof raw === 'object') {
    const keys = Object.keys(raw as Record<string, unknown>);
    const offenders = keys.filter((k) => (BLOODLINE_FIELDS as readonly string[]).includes(k));
    if (offenders.length > 0) {
      throw new ApiError(
        'validation_error',
        `variant/composite lineage fields cannot be edited via this endpoint: ${offenders.join(', ')}`,
        400,
      );
    }
  }
}

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 50;

function parseTimelineLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_TIMELINE_LIMIT;
  // Strict positive-integer match — Number.parseInt is too lenient and would
  // accept partial-numeric input ('10abc' → 10, '1.5' → 1). Require the WHOLE
  // string to be a positive integer before parsing.
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ApiError('validation_error', `invalid timeline_limit '${raw}'`, 400);
  }
  const parsed = Number.parseInt(raw, 10);
  return Math.min(parsed, MAX_TIMELINE_LIMIT);
}

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }
    const url = new URL(req.url);
    const timelineLimit = parseTimelineLimit(url.searchParams.get('timeline_limit'));

    const detail = await loadQuestionDetail(db, parsed.data.id, timelineLimit);
    if (!detail) {
      throw new ApiError('not_found', `question ${parsed.data.id} not found`, 404);
    }
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}

// ── PATCH — edit the question-bank editable surface (YUK-281) ─────────────────
export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = ParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }
    const id = parsedParams.data.id;

    const raw = await req.json().catch(() => null);
    // Loud bloodline rejection BEFORE the generic .strict() error so the message
    // names the lineage fields explicitly.
    rejectBloodlineKeys(raw);
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { version, ...patch } = parsed.data;

    // Require at least one editable field (version-only PATCH is a no-op error).
    if (Object.keys(patch).length === 0) {
      throw new ApiError('validation_error', 'no editable fields provided', 400);
    }

    // Validate knowledge_ids exist (non-archived) for a friendly early 400.
    // An empty array is a deliberate "clear all knowledge associations" — valid
    // and skipped here. editQuestion re-validates inside its transaction to close
    // the TOCTOU window (a node archived between this check and the commit).
    if (patch.knowledge_ids && patch.knowledge_ids.length > 0) {
      const check = await assertKnowledgeIdsExist(db, patch.knowledge_ids);
      if (!check.ok) {
        throw new ApiError(
          'validation_error',
          `unknown knowledge_ids: ${check.missing.join(', ')}`,
          400,
        );
      }
    }

    const result = await editQuestion(db, id, version, patch, 'self');
    if (result.status === 'not_found') {
      throw new ApiError('not_found', `question ${id} not found`, 404);
    }
    if (result.status === 'knowledge_invalid') {
      throw new ApiError(
        'validation_error',
        `unknown knowledge_ids: ${(result.missing_knowledge_ids ?? []).join(', ')}`,
        400,
      );
    }
    if (result.status === 'conflict') {
      throw new ApiError('conflict', `question ${id} concurrently modified`, 409);
    }

    // `noop` (patch matched the current row) returns ok with the unchanged
    // version and no event_id — the client can treat it as a successful save.
    return Response.json({
      ok: true,
      noop: result.status === 'noop',
      version: result.version,
      event_id: result.event_id,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── DELETE — association-count guard + soft-archive (YUK-281) ─────────────────
// Two-step:
//   1. no `?confirm=true`  → return association counts + 409 ('confirm_required')
//      so the UI can show the "N 条作答 / N 张复习卡 / N 份卷引用 / N 条错题" warning.
//      When the question has ZERO associations we still require confirm for a
//      uniform UI flow (cheap), but the counts are all 0.
//   2. `?confirm=true`     → soft-archive (re-draft) + cascade parts + event.
export async function DELETE(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = ParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }
    const id = parsedParams.data.id;
    const url = new URL(req.url);
    const confirm = url.searchParams.get('confirm') === 'true';

    const counts = await countQuestionAssociations(db, id);

    if (!confirm) {
      // Confirmation gate runs BEFORE version validation: the first (unconfirmed)
      // DELETE must always return the 409 association warning the UI needs, even
      // if the caller hasn't supplied ?version yet. version is only required for
      // the confirmed destructive write below.
      return Response.json(
        {
          error: 'confirm_required',
          message: 'question has associations; re-send with ?confirm=true to archive',
          associations: counts,
          has_associations: hasAnyAssociation(counts),
        },
        { status: 409 },
      );
    }

    // `version` is required for optimistic locking on the confirmed write.
    // Strict integer match (Number.parseInt is too lenient: '5abc' → 5). 0 is a
    // valid version (a freshly-created question), so allow a bare '0'.
    const versionRaw = url.searchParams.get('version');
    if (!versionRaw || !/^(0|[1-9]\d*)$/.test(versionRaw)) {
      throw new ApiError(
        'validation_error',
        'version query param required (non-negative integer)',
        400,
      );
    }
    const version = Number.parseInt(versionRaw, 10);

    const result = await archiveQuestion(db, id, version, 'self');
    if (result.status === 'not_found') {
      throw new ApiError('not_found', `question ${id} not found`, 404);
    }
    if (result.status === 'conflict') {
      throw new ApiError('conflict', `question ${id} concurrently modified`, 409);
    }

    return Response.json({
      ok: true,
      archived: true,
      event_id: result.event_id,
      cascaded_part_ids: result.cascaded_part_ids ?? [],
      associations: counts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
