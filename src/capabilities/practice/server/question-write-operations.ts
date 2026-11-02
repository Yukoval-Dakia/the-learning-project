import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { assertKnowledgeIdsExist } from '@/kernel/read-models/knowledge-validate';
import {
  QuestionParamsSchema,
  RestoreQuestionBodySchema,
  UpdateQuestionBodySchema,
} from '../api/question-solve-contracts';
import {
  BLOODLINE_FIELDS,
  archiveQuestion,
  countQuestionAssociations,
  editQuestion,
  hasAnyAssociation,
  restoreQuestion,
} from './question-bank-write';

export async function restorePracticeQuestion(
  db: Db,
  params: Record<string, string>,
  readBody: () => Promise<unknown>,
) {
  const parsedParams = QuestionParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    throw new ApiError('validation_error', 'question id is required', 400);
  }
  const id = parsedParams.data.id;

  const raw = await readBody().catch(() => null);
  const parsed = RestoreQuestionBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('validation_error', 'body must be { version: non-negative integer }', 400);
  }

  const result = await restoreQuestion(db, id, parsed.data.version, 'self');
  if (result.status === 'not_found') {
    throw new ApiError('not_found', `question ${id} not found`, 404);
  }
  if (result.status === 'protected') {
    throw new ApiError(
      'immutable_question',
      'intervention diagnostic questions cannot be restored through the question bank',
      409,
    );
  }
  if (result.status === 'not_archived') {
    throw new ApiError('conflict', `question ${id} is not archived`, 409);
  }
  if (result.status === 'claim_conflict') {
    throw new ApiError(
      'conflict',
      `restore would collide with live question ${result.conflicting_question_id} holding the same content claim`,
      409,
    );
  }
  if (result.status === 'conflict') {
    throw new ApiError('conflict', `question ${id} concurrently modified`, 409);
  }

  return { ok: true, restored: true, event_id: result.event_id } as const;
}

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

export async function updatePracticeQuestion(
  db: Db,
  params: Record<string, string>,
  readBody: () => Promise<unknown>,
) {
  const parsedParams = QuestionParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    throw new ApiError('validation_error', 'question id is required', 400);
  }
  const id = parsedParams.data.id;

  const raw = await readBody().catch(() => null);
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
  return {
    ok: true,
    noop: result.status === 'noop',
    version: result.version,
    event_id: result.event_id,
  } as const;
}

export async function archivePracticeQuestion(
  db: Db,
  params: Record<string, string>,
  readQuery: () => URLSearchParams,
) {
  const parsedParams = QuestionParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    throw new ApiError('validation_error', 'question id is required', 400);
  }
  const id = parsedParams.data.id;
  const query = readQuery();
  const confirm = query.get('confirm') === 'true';
  const confirmChildren = query.get('confirm_children') === 'true';

  const counts = await countQuestionAssociations(db, id);

  if (!confirm) {
    // Confirmation gate runs BEFORE version validation: the first (unconfirmed)
    // DELETE must always return the 409 association warning the UI needs, even
    // if the caller hasn't supplied ?version yet. version is only required for
    // the confirmed destructive write below.
    return {
      status: 409,
      body: {
        error: 'confirm_required',
        message: 'question has associations; re-send with ?confirm=true to archive',
        associations: counts,
        has_associations: hasAnyAssociation(counts),
      },
    } as const;
  }

  if (counts.children > 0 && !confirmChildren) {
    return {
      status: 409,
      body: {
        error: 'children_confirmation_required',
        message:
          'question has attached children; re-send with ?confirm=true&confirm_children=true to archive',
        associations: counts,
        has_associations: true,
      },
    } as const;
  }

  // `version` is required for optimistic locking on the confirmed write.
  // Strict integer match (Number.parseInt is too lenient: '5abc' → 5). 0 is a
  // valid version (a freshly-created question), so allow a bare '0'.
  const versionRaw = query.get('version');
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

  return {
    status: 200,
    body: {
      ok: true,
      archived: true,
      event_id: result.event_id,
      cascaded_part_ids: result.cascaded_part_ids ?? [],
      associations: counts,
    },
  } as const;
}
