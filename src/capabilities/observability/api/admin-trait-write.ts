// YUK-601 (v3.2 §3.1/§3.2/§3.4) — trait 直址写面三壳：
//   PUT           /api/admin/traits/:id                → editSharedTrait（显式共享写，影响全部绑定者）
//   ROLLBACK      /api/admin/traits/:id/rollback       → rollbackTrait（rollback-forward）
//   RESET_TO_SEED /api/admin/traits/:id/reset-to-seed  → resetTraitToSeed（恢复出厂，全局显式）
// 业务在 src/server/subjects/trait-write.ts；写成功后 post-commit 重水合上架。

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import { editSharedTrait, resetTraitToSeed, rollbackTrait } from '@/server/subjects/trait-write';
import { z } from 'zod';
import { readJsonBody, traitResultResponse } from './subjects-write-http';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

function parseTraitId(
  params: Record<string, string>,
): { ok: true; id: string } | { ok: false; response: Response } {
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      response: Response.json({ error: 'trait id is required' }, { status: 400 }),
    };
  }
  return { ok: true, id: parsed.data.id };
}

const EditBody = z.object({
  expectedRevision: z.number().int().min(0),
  payload: z.unknown(),
});

export async function PUT(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseTraitId(params);
    if (!p.ok) return p.response;
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = EditBody.safeParse(body.value);
    if (!parsed.success) {
      return Response.json({ error: 'expectedRevision + payload required' }, { status: 400 });
    }
    const result = await editSharedTrait(db, {
      traitId: p.id,
      expectedRevision: parsed.data.expectedRevision,
      payload: parsed.data.payload,
    });
    if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}

const RollbackBody = z.object({
  expectedRevision: z.number().int().min(0),
  targetRevision: z.number().int().min(0),
});

export async function ROLLBACK(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseTraitId(params);
    if (!p.ok) return p.response;
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = RollbackBody.safeParse(body.value);
    if (!parsed.success) {
      return Response.json(
        { error: 'expectedRevision + targetRevision required' },
        { status: 400 },
      );
    }
    const result = await rollbackTrait(db, {
      traitId: p.id,
      expectedRevision: parsed.data.expectedRevision,
      targetRevision: parsed.data.targetRevision,
    });
    if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}

const ResetToSeedBody = z.object({ expectedRevision: z.number().int().min(0) });

export async function RESET_TO_SEED(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const p = parseTraitId(params);
    if (!p.ok) return p.response;
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = ResetToSeedBody.safeParse(body.value);
    if (!parsed.success) {
      return Response.json({ error: 'expectedRevision required' }, { status: 400 });
    }
    const result = await resetTraitToSeed(db, {
      traitId: p.id,
      expectedRevision: parsed.data.expectedRevision,
    });
    if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}
