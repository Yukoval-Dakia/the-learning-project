// YUK-601 (v3.2 §3.4) — 控制行写面五壳：
//   PATCH    /api/admin/subjects/:id           → renameSubject
//   RETIRE   /api/admin/subjects/:id/retire    → retireSubject
//   RESTORE  /api/admin/subjects/:id/restore   → restoreSubject
//   RESET    /api/admin/subjects/:id/reset     → resetSubject（只换绑）
//   VALIDATE /api/admin/subjects/:id/validate  → validateSubject（无状态，零落库）
// 业务在 src/server/subjects/subject-control-write.ts；写成功后重水合上架
// （rename/reset 改 displayName/绑定拓扑，retire/restore 改三集合归属）。

import { type Db, db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import {
  type ControlWriteResult,
  renameSubject,
  resetSubject,
  restoreSubject,
  retireSubject,
  validateSubject,
} from '@/server/subjects/subject-control-write';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import { z } from 'zod';
import { controlResultResponse, readJsonBody } from './subjects-write-http';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

function parseSubjectId(
  params: Record<string, string>,
): { ok: true; id: string } | { ok: false; response: Response } {
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      response: Response.json({ error: 'subject id is required' }, { status: 400 }),
    };
  }
  return { ok: true, id: parsed.data.id };
}

const RenameBody = z.object({
  expectedRevision: z.number().int().min(0),
  displayName: z.string(),
});

export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseSubjectId(params);
    if (!p.ok) return p.response;
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = RenameBody.safeParse(body.value);
    if (!parsed.success) {
      return Response.json({ error: 'expectedRevision + displayName required' }, { status: 400 });
    }
    const result = await renameSubject(db, {
      subjectId: p.id,
      expectedRevision: parsed.data.expectedRevision,
      displayName: parsed.data.displayName,
    });
    if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
    return controlResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}

const CasBody = z.object({ expectedRevision: z.number().int().min(0) });

function casHandler(
  fn: (
    db: Db,
    args: { subjectId: string; expectedRevision: number },
  ) => Promise<ControlWriteResult>,
) {
  return async (req: Request, params: Record<string, string>): Promise<Response> => {
    try {
      const p = parseSubjectId(params);
      if (!p.ok) return p.response;
      const body = await readJsonBody(req);
      if (!body.ok) return body.response;
      const parsed = CasBody.safeParse(body.value);
      if (!parsed.success) {
        return Response.json({ error: 'expectedRevision required' }, { status: 400 });
      }
      const result = await fn(db, {
        subjectId: p.id,
        expectedRevision: parsed.data.expectedRevision,
      });
      if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
      return controlResultResponse(result);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const RETIRE = casHandler(retireSubject);
export const RESTORE = casHandler(restoreSubject);
export const RESET = casHandler(resetSubject);

const ValidateBody = z.object({
  traitPayloadOverrides: z.record(z.enum(SUBJECT_TRAIT_KINDS), z.unknown()).optional(),
});

export async function VALIDATE(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseSubjectId(params);
    if (!p.ok) return p.response;
    // 无 body 也合法（纯现状校验）。
    let overrides: Record<string, unknown> | undefined;
    try {
      const raw = (await req.json()) as unknown;
      const parsed = ValidateBody.safeParse(raw);
      if (!parsed.success) {
        return Response.json(
          { error: 'traitPayloadOverrides must be keyed by trait kind' },
          { status: 400 },
        );
      }
      overrides = parsed.data.traitPayloadOverrides;
    } catch {
      overrides = undefined;
    }
    const result = await validateSubject(db, p.id, overrides);
    if (result === null) {
      return Response.json({ error: `unknown subject "${p.id}"` }, { status: 404 });
    }
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
