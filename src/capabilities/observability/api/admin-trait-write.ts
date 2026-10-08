// YUK-601 (v3.2 §3.1/§3.2/§3.4) — trait 直址写面三壳：
//   PUT           /api/admin/traits/:id                → editSharedTrait（显式共享写，影响全部绑定者）
//   ROLLBACK      /api/admin/traits/:id/rollback       → rollbackTrait（rollback-forward）
//   RESET_TO_SEED /api/admin/traits/:id/reset-to-seed  → resetTraitToSeed（恢复出厂，全局显式）
// Shared operations own post-commit hydration; JSON and Response stay in this adapter.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import {
  EditSharedTraitInputSchema as EditBody,
  AdminTraitWriteParamsSchema as ParamsSchema,
  ResetAdminTraitBodySchema as ResetToSeedBody,
  RollbackAdminTraitBodySchema as RollbackBody,
  editSharedTrait,
  resetTraitToSeed,
  rollbackTrait,
} from '../server/trait-control-operations';
import { readJsonBody, traitResultResponse } from './subjects-write-http';

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
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}

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
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}

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
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}
