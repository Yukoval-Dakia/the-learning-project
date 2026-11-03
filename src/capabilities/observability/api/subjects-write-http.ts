// Admin subject/trait result → HTTP decisions for server/admin-control-request.ts, plus
// the Hono adapter that renders those outcomes. Stale carries currentRevision so the UI knows to refetch; a conflict omits
// it because retrying cannot help.

import type { Db } from '@/db/client';
import { canonicalResourceResponse, errorResponse } from '@/kernel/http';
import type {
  AdminControlReadRequest,
  AdminControlWriteRequest,
} from '../server/admin-control-request';
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

type RenderableOutcome =
  | { ok: true; body: unknown; canonical?: TraitWriteCanonical }
  | { ok: false; status: number; body: unknown };

/** Canonical trait writes answer 201 + Location when a fork was created. */
async function adminRequestResponse(outcome: RenderableOutcome): Promise<Response> {
  if (!outcome.ok) return Response.json(outcome.body, { status: outcome.status });
  const response = Response.json(outcome.body, { status: 200 });
  if (!outcome.canonical) return response;
  return canonicalResourceResponse(response, {
    outcome: outcome.canonical.created ? 'created' : 'existing',
    location: outcome.canonical.location,
  });
}

/**
 * Hono adapter for the admin control requests. Query values follow URLSearchParams.get
 * (first value wins); `optional` bodies read empty as absent so validate stays a pure check.
 */
export function adminControlRoute(
  db: Db,
  operation: (
    db: Db,
    request: AdminControlReadRequest & AdminControlWriteRequest,
  ) => Promise<RenderableOutcome>,
  body: 'json' | 'optional' = 'json',
) {
  return async (req: Request, params: Record<string, string> = {}): Promise<Response> => {
    try {
      const query: Record<string, string> = {};
      for (const [key, value] of new URL(req.url).searchParams) {
        if (!Object.hasOwn(query, key)) query[key] = value;
      }
      const readBody =
        body === 'json'
          ? () => req.json()
          : async () => {
              const text = await req.text();
              return text.trim().length > 0 ? JSON.parse(text) : undefined;
            };
      return await adminRequestResponse(await operation(db, { params, query, readBody }));
    } catch (err) {
      return errorResponse(err);
    }
  };
}
