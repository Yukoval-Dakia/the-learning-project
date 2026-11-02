// Shared write-result to HTTP mapping. Stale carries currentRevision so the UI knows to
// refetch (hand-built because ApiError nests extras under details); a conflict omits it
// because retrying cannot help.

import type { ControlWriteResult } from '../server/subject-control-write';
import type { TraitWriteResult } from '../server/trait-write';

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
