// YUK-601 (v3.2 §3.1/§3.3) — subject-scoped trait 写面三壳：
//   PUT     /api/admin/subjects/:id/traits/:kind          → editSubjectTrait（主写面，自动 COW）
//   FORK    /api/admin/subjects/:id/traits/:kind/fork     → forkSubjectTrait（显式剥离）
//   BINDING /api/admin/subjects/:id/traits/:kind/binding  → rebindSubjectTrait（换绑）
// 业务在 src/server/subjects/trait-write.ts；写成功后 post-commit 重水合上架。

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import {
  editSubjectTrait,
  forkSubjectTrait,
  rebindSubjectTrait,
} from '@/server/subjects/trait-write';
import { SUBJECT_TRAIT_KINDS, type SubjectTraitKind } from '@/subjects/trait-schemas';
import { z } from 'zod';
import { readJsonBody, traitResultResponse } from './subjects-write-http';

const ParamsSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.enum(SUBJECT_TRAIT_KINDS),
});

function parseParams(
  params: Record<string, string>,
): { ok: true; id: string; kind: SubjectTraitKind } | { ok: false; response: Response } {
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      response: Response.json(
        { error: `subject id + trait kind (one of: ${SUBJECT_TRAIT_KINDS.join(', ')}) required` },
        { status: 400 },
      ),
    };
  }
  return { ok: true, id: parsed.data.id, kind: parsed.data.kind };
}

const EditBody = z.object({
  expectedSubjectRevision: z.number().int().min(0),
  expectedTraitRevision: z.number().int().min(0),
  payload: z.unknown(),
});

export async function PUT(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = EditBody.safeParse(body.value);
    if (!parsed.success) {
      return Response.json(
        { error: 'expectedSubjectRevision + expectedTraitRevision + payload required' },
        { status: 400 },
      );
    }
    const result = await editSubjectTrait(db, {
      subjectId: p.id,
      kind: p.kind,
      expectedSubjectRevision: parsed.data.expectedSubjectRevision,
      expectedTraitRevision: parsed.data.expectedTraitRevision,
      payload: parsed.data.payload,
    });
    if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}

const ForkBody = z.object({ expectedSubjectRevision: z.number().int().min(0) });

export async function FORK(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = ForkBody.safeParse(body.value);
    if (!parsed.success) {
      return Response.json({ error: 'expectedSubjectRevision required' }, { status: 400 });
    }
    const result = await forkSubjectTrait(db, {
      subjectId: p.id,
      kind: p.kind,
      expectedSubjectRevision: parsed.data.expectedSubjectRevision,
    });
    if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}

const BindingBody = z.object({
  targetTraitId: z.string().trim().min(1),
  expectedSubjectRevision: z.number().int().min(0),
});

export async function BINDING(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const p = parseParams(params);
    if (!p.ok) return p.response;
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = BindingBody.safeParse(body.value);
    if (!parsed.success) {
      return Response.json(
        { error: 'targetTraitId + expectedSubjectRevision required' },
        { status: 400 },
      );
    }
    const result = await rebindSubjectTrait(db, {
      subjectId: p.id,
      kind: p.kind,
      targetTraitId: parsed.data.targetTraitId,
      expectedSubjectRevision: parsed.data.expectedSubjectRevision,
    });
    if (result.kind === 'ok') await hydrateSubjectRegistryFromDb(db);
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}
