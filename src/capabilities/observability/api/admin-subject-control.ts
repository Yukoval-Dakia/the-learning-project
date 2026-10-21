// Subject control writes: rename, retire, restore, reset and a stateless validate.
// Shared operations live in the server module; a successful write rehydrates the
// registry.

import { type Db, db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import {
  AdminSubjectCasBodySchema,
  type AdminSubjectCasInput,
  AdminSubjectControlParamsSchema,
  type AdminSubjectControlResult,
  RenameAdminSubjectBodySchema,
  ValidateAdminSubjectInputSchema,
  renameAdminSubject,
  resetAdminSubject,
  restoreAdminSubject,
  retireAdminSubject,
  validateAdminSubject,
} from '../server/subject-control-operations';
import { controlResultResponse, readJsonBody } from './subjects-write-http';

function parseSubjectId(
  params: Record<string, string>,
): { ok: true; id: string } | { ok: false; response: Response } {
  const parsed = AdminSubjectControlParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      response: Response.json({ error: 'subject id is required' }, { status: 400 }),
    };
  }
  return { ok: true, id: parsed.data.id };
}

export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseSubjectId(params);
    if (!p.ok) return p.response;
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = RenameAdminSubjectBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return Response.json({ error: 'expectedRevision + displayName required' }, { status: 400 });
    }
    const result = await renameAdminSubject(db, {
      subjectId: p.id,
      expectedRevision: parsed.data.expectedRevision,
      displayName: parsed.data.displayName,
    });
    return controlResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}

function casHandler(
  fn: (db: Db, args: AdminSubjectCasInput) => Promise<AdminSubjectControlResult>,
) {
  return async (req: Request, params: Record<string, string>): Promise<Response> => {
    try {
      const p = parseSubjectId(params);
      if (!p.ok) return p.response;
      const body = await readJsonBody(req);
      if (!body.ok) return body.response;
      const parsed = AdminSubjectCasBodySchema.safeParse(body.value);
      if (!parsed.success) {
        return Response.json({ error: 'expectedRevision required' }, { status: 400 });
      }
      const result = await fn(db, {
        subjectId: p.id,
        expectedRevision: parsed.data.expectedRevision,
      });
      return controlResultResponse(result);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const RETIRE = casHandler(retireAdminSubject);
export const RESTORE = casHandler(restoreAdminSubject);
export const RESET = casHandler(resetAdminSubject);

export async function VALIDATE(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseSubjectId(params);
    if (!p.ok) return p.response;
    // Empty body is valid for a pure check, but malformed JSON is still 400.
    let overrides: Record<string, unknown> | undefined;
    const rawText = await req.text();
    if (rawText.trim().length > 0) {
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        return Response.json({ error: 'request body must be valid JSON' }, { status: 400 });
      }
      const parsed = ValidateAdminSubjectInputSchema.safeParse(raw);
      if (!parsed.success) {
        return Response.json(
          { error: 'traitPayloadOverrides must be keyed by trait kind' },
          { status: 400 },
        );
      }
      overrides = parsed.data.traitPayloadOverrides;
    }
    const result = await validateAdminSubject(db, {
      subjectId: p.id,
      traitPayloadOverrides: overrides,
    });
    if (result === null) {
      return Response.json({ error: `unknown subject "${p.id}"` }, { status: 404 });
    }
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
