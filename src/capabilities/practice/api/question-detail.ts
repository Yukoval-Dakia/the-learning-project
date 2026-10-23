// GET /api/questions/[id]: the question-bank detail read.
// PATCH (edit) + DELETE (archive with an association-count guard).
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

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { assertKnowledgeIdsExist } from '@/kernel/read-models/knowledge-validate';
import {
  BLOODLINE_FIELDS,
  archiveQuestion,
  countQuestionAssociations,
  editQuestion,
  hasAnyAssociation,
} from '@/server/questions/write';
import { readQuestionDetail } from '../server/question-detail-read';
import { QuestionParamsSchema, UpdateQuestionBodySchema } from './question-solve-contracts';

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

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const url = new URL(req.url);
    const detail = await readQuestionDetail(db, params, {
      timelineLimit: url.searchParams.get('timeline_limit'),
      surface: url.searchParams.get('surface'),
    });
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}

// ── PATCH — edit the question-bank editable surface ─────────────────────────
export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = QuestionParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }
    const id = parsedParams.data.id;

    const raw = await req.json().catch(() => null);
    // Loud bloodline rejection BEFORE the generic .strict() error so the message
    // names the lineage fields explicitly.
    rejectBloodlineKeys(raw);
    const parsed = UpdateQuestionBodySchema.safeParse(raw);
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
    if (result.status === 'protected') {
      throw new ApiError(
        'immutable_question',
        'intervention diagnostic questions cannot be edited through the question bank',
        409,
      );
    }
    if (result.status === 'composite_lifecycle') {
      throw new ApiError(
        'composite_lifecycle',
        'draft_status on a composite parent or question_part is group-owned: parts promote via the parent verify cascade (or owner force-enable), and a parent deactivates via archive',
        409,
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

// ── DELETE — association-count guard + soft-archive ─────────────────────────
// Two-step:
//   1. no `?confirm=true`  → return association counts + 409 ('confirm_required')
//      so the UI can show the "N 条作答 / N 张复习卡 / N 份卷引用 / N 条错题 / N 道小题" warning.
//      When the question has ZERO associations we still require confirm for a
//      uniform UI flow (cheap), but the counts are all 0.
//   2. `?confirm=true`     → soft-archive (re-draft) + cascade parts + event.
//      When children exist, `?confirm_children=true` is additionally required.
//      This fail-closed protocol prevents an older web bundle from silently
//      confirming a cascade after a newer API starts reporting child counts.
export async function DELETE(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = QuestionParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }
    const id = parsedParams.data.id;
    const url = new URL(req.url);
    const confirm = url.searchParams.get('confirm') === 'true';
    const confirmChildren = url.searchParams.get('confirm_children') === 'true';

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

    if (counts.children > 0 && !confirmChildren) {
      return Response.json(
        {
          error: 'children_confirmation_required',
          message:
            'question has attached children; re-send with ?confirm=true&confirm_children=true to archive',
          associations: counts,
          has_associations: true,
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
    if (result.status === 'protected') {
      throw new ApiError(
        'immutable_question',
        'intervention diagnostic questions cannot be archived through the question bank',
        409,
      );
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
