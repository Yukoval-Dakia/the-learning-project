// Admin subject/trait result → HTTP decisions, shared by the Hono routes and the Start
// front door. Stale carries currentRevision so the UI knows to refetch; a conflict omits
// it because retrying cannot help.

import { canonicalResourceResponse } from '@/kernel/http';
import type { ControlWriteResult } from '../server/subject-control-write';
import type { TraitWriteResult } from '../server/trait-write';

export type AdminWriteErrorBody = {
  error: string;
  message?: string;
  currentRevision?: number;
  issues?: Extract<TraitWriteResult, { kind: 'invalid' }>['issues'];
};
export type AdminWriteHttpOutcome<T, Success extends object = Record<never, never>> =
  | ({ ok: true; body: T } & Success)
  | { ok: false; status: 404 | 409 | 422; body: AdminWriteErrorBody };

export type SubjectControlReceiptBody = { subjectRevision: number; noop?: true };
export type TraitReceiptBody =
  | { traitId: string; revision: number; forked: boolean }
  | { traitId: string; revision: number; noop: true };
/** Canonical-resource facts for the subject-scoped edit/fork writes (201 + Location). */
export type TraitWriteCanonical = { created: boolean; location: string };

export function traitWriteHttpOutcome(
  result: TraitWriteResult,
): AdminWriteHttpOutcome<TraitReceiptBody, TraitWriteCanonical> {
  switch (result.kind) {
    case 'ok':
    case 'noop':
      return {
        ok: true,
        body:
          result.kind === 'ok'
            ? { traitId: result.traitId, revision: result.revision, forked: result.forked }
            : { traitId: result.traitId, revision: result.revision, noop: true },
        created: result.kind === 'ok' && result.forked,
        location: `/api/admin/traits/${encodeURIComponent(result.traitId)}/journal`,
      };
    case 'stale':
      return {
        ok: false,
        status: 409,
        body: {
          error: 'stale_revision',
          message: `stale ${result.axis} revision`,
          currentRevision: result.currentRevision,
        },
      };
    case 'not_found':
      return { ok: false, status: 404, body: { error: result.message } };
    case 'forbidden':
      return { ok: false, status: 422, body: { error: result.message } };
    case 'invalid':
      return {
        ok: false,
        status: 422,
        body: { error: result.message, ...(result.issues ? { issues: result.issues } : {}) },
      };
  }
}

export function controlWriteHttpOutcome(
  result: ControlWriteResult,
): AdminWriteHttpOutcome<SubjectControlReceiptBody> {
  switch (result.kind) {
    case 'ok':
      return { ok: true, body: { subjectRevision: result.subjectRevision } };
    case 'noop':
      return { ok: true, body: { subjectRevision: result.subjectRevision, noop: true } };
    case 'stale':
      return {
        ok: false,
        status: 409,
        body: {
          error: 'stale_revision',
          message: 'stale subject revision',
          currentRevision: result.currentRevision,
        },
      };
    case 'conflict':
      return { ok: false, status: 409, body: { error: result.message } };
    case 'not_found':
      return { ok: false, status: 404, body: { error: result.message } };
    case 'forbidden':
    case 'invalid':
      return { ok: false, status: 422, body: { error: result.message } };
  }
}

const TRAIT_JOURNAL_DEFAULT_LIMIT = 100;
const TRAIT_JOURNAL_MAX_LIMIT = 200;

/** Absent → default; anything but a positive integer → 400; oversized requests are clamped. */
export function parseTraitJournalLimit(
  raw: string | null | undefined,
): { ok: true; limit: number } | { ok: false; status: 400; body: { error: string } } {
  const requested = raw == null ? TRAIT_JOURNAL_DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(requested) || requested <= 0) {
    return { ok: false, status: 400, body: { error: 'limit must be a positive integer' } };
  }
  return { ok: true, limit: Math.min(requested, TRAIT_JOURNAL_MAX_LIMIT) };
}

function outcomeResponse<T, S extends object>(outcome: AdminWriteHttpOutcome<T, S>): Response {
  return outcome.ok
    ? Response.json(outcome.body, { status: 200 })
    : Response.json(outcome.body, { status: outcome.status });
}

export function traitResultResponse(result: TraitWriteResult): Response {
  return outcomeResponse(traitWriteHttpOutcome(result));
}

/** Edit/fork answer as a canonical resource: 201 + Location when a fork was created. */
export async function canonicalTraitResultResponse(result: TraitWriteResult): Promise<Response> {
  const outcome = traitWriteHttpOutcome(result);
  const response = outcomeResponse(outcome);
  if (!outcome.ok) return response;
  return canonicalResourceResponse(response, {
    outcome: outcome.created ? 'created' : 'existing',
    location: outcome.location,
  });
}

export function controlResultResponse(result: ControlWriteResult): Response {
  return outcomeResponse(controlWriteHttpOutcome(result));
}

export async function readJsonBody(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: 'request body must be valid JSON' }, { status: 400 }),
    };
  }
}
