// Shared write-result to HTTP mapping.
//
// ok/noop are 200; stale is 409 carrying currentRevision so the UI knows to refetch;
// a name conflict is 409 without it, because retrying cannot help; not_found is 404;
// forbidden and invalid are 422, with fan-out issues when present. Stale builds its
// response by hand because ApiError cannot carry the extra revision field.

import type { ControlWriteResult } from '@/server/subjects/subject-control-write';
import type { TraitWriteResult } from '@/server/subjects/trait-write';

export function traitResultResponse(result: TraitWriteResult): Response {
  switch (result.kind) {
    case 'ok':
      return Response.json(
        { traitId: result.traitId, revision: result.revision, forked: result.forked },
        { status: 200 },
      );
    case 'noop':
      return Response.json(
        { traitId: result.traitId, revision: result.revision, noop: true },
        { status: 200 },
      );
    case 'stale':
      return Response.json(
        {
          error: 'stale_revision',
          message: `stale ${result.axis} revision`,
          currentRevision: result.currentRevision,
        },
        { status: 409 },
      );
    case 'not_found':
      return Response.json({ error: result.message }, { status: 404 });
    case 'forbidden':
      return Response.json({ error: result.message }, { status: 422 });
    case 'invalid':
      return Response.json(
        { error: result.message, ...(result.issues ? { issues: result.issues } : {}) },
        { status: 422 },
      );
  }
}

export function controlResultResponse(result: ControlWriteResult): Response {
  switch (result.kind) {
    case 'ok':
      return Response.json({ subjectRevision: result.subjectRevision }, { status: 200 });
    case 'noop':
      return Response.json(
        { subjectRevision: result.subjectRevision, noop: true },
        { status: 200 },
      );
    case 'stale':
      return Response.json(
        {
          error: 'stale_revision',
          message: 'stale subject revision',
          currentRevision: result.currentRevision,
        },
        { status: 409 },
      );
    case 'conflict':
      return Response.json({ error: result.message }, { status: 409 });
    case 'not_found':
      return Response.json({ error: result.message }, { status: 404 });
    case 'forbidden':
      return Response.json({ error: result.message }, { status: 422 });
    case 'invalid':
      return Response.json({ error: result.message }, { status: 422 });
  }
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
