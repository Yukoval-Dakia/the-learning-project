// YUK-601 (v3.2 §3.1/§3.3) — subject-scoped trait 写面三壳：
//   PUT     /api/admin/subjects/:id/traits/:kind          → editSubjectTrait（主写面，自动 COW）
//   FORK    /api/admin/subjects/:id/traits/:kind/fork     → forkSubjectTrait（显式剥离）
//   BINDING /api/admin/subjects/:id/traits/:kind/binding  → rebindSubjectTrait（换绑）
// Shared operations own post-commit hydration; JSON and Response stay in this adapter.

import { db } from '@/db/client';
import { canonicalResourceResponse, errorResponse } from '@/kernel/http';
import { SUBJECT_TRAIT_KINDS, type SubjectTraitKind } from '@/subjects/trait-schemas';
import {
  RebindSubjectTraitBodySchema as BindingBody,
  EditSubjectTraitInputSchema as EditBody,
  ForkSubjectTraitBodySchema as ForkBody,
  AdminSubjectTraitParamsSchema as ParamsSchema,
  editSubjectTrait,
  forkSubjectTrait,
  rebindSubjectTrait,
} from '../server/trait-control-operations';
import { readJsonBody, traitResultResponse } from './subjects-write-http';

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
    const response = traitResultResponse(result);
    if (result.kind !== 'ok' && result.kind !== 'noop') return response;
    return canonicalResourceResponse(response, {
      outcome: result.kind === 'ok' && result.forked ? 'created' : 'existing',
      location: `/api/admin/traits/${encodeURIComponent(result.traitId)}/journal`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

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
    const response = traitResultResponse(result);
    if (result.kind !== 'ok' && result.kind !== 'noop') return response;
    return canonicalResourceResponse(response, {
      outcome: result.kind === 'ok' && result.forked ? 'created' : 'existing',
      location: `/api/admin/traits/${encodeURIComponent(result.traitId)}/journal`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

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
    return traitResultResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}
